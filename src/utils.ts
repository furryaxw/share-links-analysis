// src/utils.ts
import {ParsedInfo, PluginConfig} from './types';
import {Context, h, Logger, Session} from "koishi";
import path from 'path';
import {createWriteStream} from 'fs';
import {promisify} from 'util';
import {pipeline} from 'stream';
import {URL} from 'url';
import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import {HttpProxyAgent} from 'http-proxy-agent';
import {HttpsProxyAgent} from 'https-proxy-agent'
import * as fs from "node:fs";
import {createHash} from 'crypto';
import 'koishi-plugin-adapter-onebot';
import {createDecipheriv} from "node:crypto";

function md5Hex(value: string): string {
    return createHash('md5').update(value).digest('hex');
}

function getFileCacheIdentity(url: string, cacheKey?: string): string {
    return cacheKey || url;
}

function getFileCacheHash(url: string, cacheKey?: string): string {
    return md5Hex(getFileCacheIdentity(url, cacheKey));
}

function getLegacyFileCacheHash(url: string): string {
    return md5Hex(url);
}

function getFileCacheHashCandidates(url: string, cacheKey?: string): string[] {
    return [...new Set([getFileCacheHash(url, cacheKey), getLegacyFileCacheHash(url)])];
}

async function findExistingFileCache(
    ctx: Context,
    url: string,
    cacheKey?: string
): Promise<{
    canonicalHash: string,
    matchedHash: string,
    path: string
} | null> {
    const canonicalHash = getFileCacheHash(url, cacheKey);

    for (const hash of getFileCacheHashCandidates(url, cacheKey)) {
        const cached = await ctx.database.get('sla_file_cache', hash);
        const cachedPath = cached[0]?.path;
        if (!cachedPath) continue;

        if (fs.existsSync(cachedPath)) {
            return {canonicalHash, matchedHash: hash, path: cachedPath};
        }

        await ctx.database.remove('sla_file_cache', {hash});
    }

    return null;
}

// 平台域名映射配置
const PLATFORM_DOMAINS = {
    'youtube': ['youtube.com', 'google.com'],
    'twitter': ['x.com', 'twitter.com', 'twimg.com'],
    'xiaohongshu': ['xiaohongshu.com'],
    'bilibili': ['bilibili.com'],
    'qqmusic': ['qq.com', 'y.qq.com'],
    'netease': ['163.com', 'music.163.com'],
    'xiaoheihe': ['xiaoheihe.cn', 'max-c.com'],
    'kugou': ['kugou.com'],
    'github': ['github.com']
};

export function buildTelemetryEndpoint(baseUrl: string, path: string): string {
    if (!baseUrl) return '';
    const cleanBase = baseUrl.replace(/\/+$/, '');
    return `${cleanBase}${path}`;
}

/**
 * OpenSSL EVP_BytesToKey 实现
 */
function evpBytesToKey(password: Buffer, salt: Buffer, keyLen: number, ivLen: number) {
    let dt = Buffer.alloc(0);
    const keyiv = Buffer.alloc(keyLen + ivLen);
    let offset = 0;

    while (offset < keyLen + ivLen) {
        const md5 = createHash('md5');
        if (dt.length > 0) md5.update(dt);
        md5.update(password);
        md5.update(salt);
        dt = md5.digest();

        const written = dt.copy(keyiv, offset);
        offset += written;
    }

    return {
        key: keyiv.subarray(0, keyLen),
        iv: keyiv.subarray(keyLen, keyLen + ivLen)
    };
}

/**
 * 解密 CookieCloud 数据
 */
function decryptCookieCloudData(encryptedBase64: string, uuid: string, password: string): any {
    try {
        const mix = uuid + '-' + password;
        const passphraseStr = createHash('md5').update(mix).digest('hex').substring(0, 16);
        const passphrase = Buffer.from(passphraseStr, 'utf8');

        const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
        if (encryptedBytes.subarray(0, 8).toString('utf8') !== 'Salted__') {
            throw new Error('Invalid encrypted data: missing Salted__ header');
        }
        const salt = encryptedBytes.subarray(8, 16);
        const ciphertext = encryptedBytes.subarray(16);

        const {key, iv} = evpBytesToKey(passphrase, salt, 32, 16);
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return JSON.parse(decrypted.toString('utf8'));
    } catch (e: any) {
        throw new Error(`CookieCloud 解密失败: ${e.message}`);
    }
}

/**
 * 主动同步：从 CookieCloud 拉取并更新数据库
 * @returns 更新了多少个平台的 Cookie
 */
export async function syncCookiesFromCloud(ctx: Context, config: PluginConfig): Promise<Record<string, string>> {
    const logger = ctx.logger('share-links-analysis:cookie-sync');
    // 定义返回字典
    const result: Record<string, string> = {};

    if (!config.cookieCloud?.enable) {
        logger.debug('CookieCloud 未启用，跳过同步');
        return result;
    }

    try {
        const {host, uuid, password} = config.cookieCloud;
        const apiUrl = `${host.replace(/\/$/, '')}/get/${uuid}`;

        logger.debug(`正在检查 CookieCloud: ${apiUrl}`);
        const res = await ctx.http.get(apiUrl);

        if (!res || !res.encrypted) {
            throw new Error('返回数据无效');
        }

        const data = decryptCookieCloudData(res.encrypted, uuid, password);
        if (!data || !data.cookie_data) return result;

        let updatedCount = 0;

        // 遍历所有支持的平台
        for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
            const matchedCookies: string[] = [];

            // 提取匹配域名的 Cookie
            for (const domainKey in data.cookie_data) {
                if (domains.some(d => domainKey.includes(d))) {
                    const cookies = data.cookie_data[domainKey];
                    cookies.forEach((c: any) => matchedCookies.push(`${c.name}=${c.value}`));
                }
            }

            if (matchedCookies.length > 0) {
                // 去重并生成 Cookie 字符串
                const uniqueMap = new Map();
                matchedCookies.forEach(c => {
                    const [k, v] = c.split('=');
                    if (k && v) uniqueMap.set(k.trim(), v.trim());
                });
                const newCookieStr = Array.from(uniqueMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

                // 1. 放入返回字典 (只要云端有，就放入返回结果，供内存使用)
                result[platform] = newCookieStr;

                // 2. 检查本地数据库 (保留原有的持久化逻辑)
                const dbRecords = await ctx.database.get('sla_cookie_cache', {platform});
                const localCookie = dbRecords?.[0]?.cookie || '';

                // 如果本地不存在 或 内容不一致，则更新数据库
                if (localCookie !== newCookieStr) {
                    await ctx.database.upsert('sla_cookie_cache', [{
                        platform: platform,
                        cookie: newCookieStr
                    }]);
                    logger.info(`平台 [${platform}] Cookie 已更新 (来源: CookieCloud)`);
                    updatedCount++;
                } else {
                    logger.debug(`平台 [${platform}] Cookie 与云端一致，无需更新`);
                }
            }
        }

        if (updatedCount > 0) {
            logger.info(`CookieCloud 同步完成，更新了 ${updatedCount} 个平台的 Cookie`);
        }

        return result;

    } catch (e: any) {
        logger.warn(`CookieCloud 同步失败: ${e.message}`);
        return {};
    }
}

/**
 * 获取 Cookie (优先本地数据库，若无则尝试同步)
 */
export async function getCookie(
    ctx: Context,
    config: PluginConfig,
    platform: string
): Promise<string> {
    const logger = ctx.logger('share-links-analysis:cookie');

    // 1. 尝试读取数据库
    let dbCache = await ctx.database.get('sla_cookie_cache', platform);

    // 2. 如果数据库里没有，且开启了云同步，尝试立即触发一次同步
    if ((!dbCache || dbCache.length === 0 || !dbCache[0].cookie) && config.cookieCloud?.enable) {
        logger.info(`本地缺失 [${platform}] Cookie，尝试从 CookieCloud 恢复...`);
        await syncCookiesFromCloud(ctx, config);
        // 同步后再次读取
        dbCache = await ctx.database.get('sla_cookie_cache', platform);
    }

    if (dbCache && dbCache.length > 0 && dbCache[0].cookie) {
        return dbCache[0].cookie;
    }

    return '';
}

/**
 * 短链展开函数
 * @param ctx Koishi Context
 * @param shortUrl 需要展开的短链
 * @param config 插件配置
 * @param logger Logger 实例
 * @param proxy 动态传入的代理地址
 * @param cookie 动态传入的平台身份票据
 * @returns 展开后的真实链接 (如果解析失败则尽力返回原链接)
 */
export async function expandShortLink(
    ctx: Context,
    shortUrl: string,
    config: PluginConfig,
    logger: Logger,
    proxy?: string,
    cookie?: string
): Promise<string> {
    let finalUrl = shortUrl;

    // 封装安全的获取 Location 方法，规避 TypeScript 对 Headers 的类型校验报错
    const getLocation = (headers: any): string | null => {
        if (!headers) return null;
        if (typeof headers.get === 'function') {
            return headers.get('location') || headers.get('Location') || null;
        }
        return headers['location'] || headers['Location'] || null;
    };

    try {
        const reqOptions: any = {
            method: 'GET',
            // 弃用强制 manual，让 HTTP 客户端自然跟随，我们抓其尾巴
            headers: {
                'User-Agent': config.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            }
        };

        if (proxy) reqOptions.proxyAgent = proxy;
        if (cookie) reqOptions.headers['Cookie'] = cookie;
        const response = await ctx.http(shortUrl, reqOptions);

        // 策略 1: Fetch 标准重定向
        if (response.url && response.url !== shortUrl) {
            finalUrl = response.url;
        }
        // 策略 2: Axios 底层重定向
        else if ((response as any)?.request?.res?.responseUrl && (response as any).request.res.responseUrl !== shortUrl) {
            finalUrl = (response as any).request.res.responseUrl;
        }
        // 策略 3: 手动拦截 3xx Location
        else if (response.status >= 300 && response.status < 400) {
            const location = getLocation(response.headers);
            if (location) finalUrl = location;
        }
        // 策略 4: 前端防爬重定向探测
        else if (response.data && typeof response.data === 'string') {
            const html = response.data;
            const metaRefreshMatch = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'>]+)["']?/i);

            if (metaRefreshMatch && metaRefreshMatch[1]) {
                finalUrl = metaRefreshMatch[1].replace(/&amp;/g, '&');
            } else {
                const jsRedirectMatch = html.match(/window\.location\.(?:replace|href)\s*=\s*["']([^"']+)["']/i);
                if (jsRedirectMatch && jsRedirectMatch[1]) {
                    finalUrl = jsRedirectMatch[1].replace(/&amp;/g, '&');
                }
            }
        }

    } catch (e: any) {
        // 发生网络异常或 4xx/5xx 时，保留 Error 级日志以供排查
        logger.error(`[Expand] 请求异常 ${shortUrl}: ${e.message}`);

        if (e.response) {
            const location = getLocation(e.response.headers);
            if (location) {
                finalUrl = location;
                logger.debug(`[Expand] 触发抢救，从异常 Header Location 中提取到终点: ${finalUrl}`);
            } else if (e.response.url && e.response.url !== shortUrl) {
                finalUrl = e.response.url;
                logger.debug(`[Expand] 触发抢救，从异常 response.url 中提取到终点: ${finalUrl}`);
            }
        }
    }

    // 处理跨域重定向可能带来的相对路径灾难
    if (finalUrl.startsWith('/')) {
        try {
            const urlObj = new URL(shortUrl);
            finalUrl = `${urlObj.protocol}//${urlObj.host}${finalUrl}`;
        } catch (err) {
            logger.error(`[Expand] 相对路径绝对化补全失败: ${err}`);
        }
    }

    // 只在最终结果处输出一条 Debug 日志比对变化
    if (finalUrl !== shortUrl) {
        logger.debug(`[Expand] 展开成功: ${shortUrl} -> ${finalUrl}`);
    } else {
        logger.debug(`[Expand] 展开失败或无需展开，保持原样: ${shortUrl}`);
    }

    return finalUrl;
}

/**
 * 将数字格式化为易读的字符串（如 万、亿）
 * @param num 数字
 * @param config 插件配置
 * @returns 格式化后的字符串
 */
export function numeral(num: number, config: PluginConfig): string {
    if (config.useNumeral) {
        if (num >= 100000000) {
            return (num / 100000000).toFixed(1) + "亿";
        }
        if (num >= 10000) {
            return (num / 10000).toFixed(1) + "万";
        }
    }
    return String(num);
}

export function escapeHtml(str: string) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function unescapeHtml(str: string): string {
    if (!str) return '';
    return str.replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

export function getProxyAgent(proxy: string | undefined, url: string): HttpAgent | HttpsAgent | undefined {
    if (!proxy) return undefined;

    const u = new URL(url);

    if (u.protocol === 'https:') {
        return new HttpsProxyAgent(proxy);
    } else {
        return new HttpProxyAgent(proxy);
    }
}

function parseHtmlToSegments(html: string): any[] {
    const segments: any[] = [];
    // 匹配 <img> 标签和普通文本
    const tokens = html.split(/(<img\s[^>]*src\s*=\s*["']?[^"'>\s]+["']?[^>]*>)/gi);

    for (const token of tokens) {
        if (!token) continue;

        const imgMatch = token.match(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/i);
        if (imgMatch) {
            const url = imgMatch[1];
            segments.push({type: 'image', data: {file: url}});
        } else {
            // 非 <img> 部分：当作普通文本（已转义，可直接使用）
            // 注意：HTML 中的换行可能是 <br> 或 \n，根据实际情况处理
            // 此处假设换行用 \n 表示（或上游已转换）
            if (token.trim() !== '') {
                segments.push({type: 'text', data: {text: token}});
            }
        }
    }

    return segments;
}

async function downloadAndMapUrl(
    ctx: Context,
    url: string,
    proxy: string | undefined,
    userAgent: string | undefined,
    localDownloadDir: string,
    onebotReadDir: string,
    logger: Logger,
    enableCache: boolean,
    statsRef?: { fileCacheHits?: number, fileCacheMisses?: number },
    cacheKey?: string
): Promise<string> {
    await fs.promises.mkdir(localDownloadDir, {recursive: true});

    // 1. 计算 Hash
    const hash = getFileCacheHash(url, cacheKey);
    const u = new URL(url);
    const ext = path.extname(u.pathname).split('?')[0] || '.bin';

    if (enableCache) {
        try {
            const cached = await findExistingFileCache(ctx, url, cacheKey);
            if (cached) {
                const filename = path.basename(cached.path);
                const onebotPath = path.posix.join(onebotReadDir, filename);
                await ctx.database.upsert('sla_file_cache', [{
                    hash: cached.canonicalHash,
                    path: cached.path,
                    url,
                    created_at: Date.now()
                }]);
                if (statsRef) statsRef.fileCacheHits = (statsRef.fileCacheHits || 0) + 1;
                logger.debug(`缓存命中: ${url} -> ${cached.path}`);
                return `file://${onebotPath}`;
            }
        } catch (e) {
            logger.warn(`读取文件缓存失败，将重新下载: ${e}`);
        }
    }

    // 如果开启缓存，先查库
    if (enableCache) {
        try {
            const cached = await ctx.database.get('sla_file_cache', hash);
            if (cached.length > 0) {
                const cachedPath = cached[0].path;
                if (fs.existsSync(cachedPath)) {
                    const filename = path.basename(cachedPath);
                    const onebotPath = path.posix.join(onebotReadDir, filename);
                    await ctx.database.upsert('sla_file_cache', [{
                        hash,
                        path: cachedPath,
                        url,
                        created_at: Date.now()
                    }]);
                    if (statsRef) statsRef.fileCacheHits = (statsRef.fileCacheHits || 0) + 1;
                    logger.debug(`缓存命中: ${url} -> ${cachedPath}`);
                    return `file://${onebotPath}`;
                } else {
                    // 数据库有记录但文件不存在，删除记录
                    await ctx.database.remove('sla_file_cache', {hash});
                }
            }
        } catch (e) {
            logger.warn(`读取文件缓存失败，将重新下载: ${e}`);
        }
    }

    // 2. 生成文件名 (使用 Hash 以实现去重)
    const safeFilename = `${hash}${ext}`;
    const actualPath = path.join(localDownloadDir, safeFilename);
    const onebotPath = path.posix.join(onebotReadDir, safeFilename);
    const fileUrl = `file://${onebotPath}`;

    // 3. 检查本地文件是否存在 (双重保险，或者应对未清理的情况)
    if (enableCache && fs.existsSync(actualPath)) {
        // 补写数据库
        await ctx.database.upsert('sla_file_cache', [{
            hash,
            path: actualPath,
            url,
            created_at: Date.now()
        }]);
        if (statsRef) statsRef.fileCacheHits = (statsRef.fileCacheHits || 0) + 1;
        return fileUrl;
    }

    const attemptDownload = (): Promise<string> => new Promise((resolve, reject) => {
        const agent = getProxyAgent(proxy, url);
        const headers: any = {
            'User-Agent': userAgent,
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8,video/*,audio/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive'
        };
        const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

        const req = getter(url, {agent, timeout: 30_000, headers}, (res: any) => {
            // 处理重定向
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                req.destroy();
                logger.debug(`重定向: ${url} -> ${res.headers.location}`);
                resolve(downloadAndMapUrl(ctx, res.headers.location, proxy, userAgent, localDownloadDir, onebotReadDir, logger, enableCache, statsRef, cacheKey));
                return;
            }

            if (res.statusCode !== 200) {
                req.destroy();
                reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
                return;
            }

            // 检查内容类型，避免下载无关网页或危险文件
            const contentType = (res.headers['content-type'] || '').toLowerCase();
            if (!contentType.startsWith('image/') &&
                !contentType.includes('video/') &&
                !contentType.includes('audio/') &&
                !contentType.includes('application/octet-stream')) {
                req.destroy();
                reject(new Error(`Unexpected content type: ${contentType}`));
                return;
            }

            const pipelineAsync = promisify(pipeline);
            pipelineAsync(res, createWriteStream(actualPath))
                .then(async () => {
                    logger.debug(`下载成功: ${url} -> ${fileUrl}`);
                    // 下载成功，写入数据库缓存
                    if (enableCache) {
                        try {
                            await ctx.database.upsert('sla_file_cache', [{
                                hash,
                                path: actualPath,
                                url,
                                created_at: Date.now()
                            }]);
                        } catch (dbErr) {
                            logger.warn(`写入文件缓存数据库失败: ${dbErr}`);
                        }
                    }
                    if (statsRef) statsRef.fileCacheMisses = (statsRef.fileCacheMisses || 0) + 1;
                    resolve(fileUrl);
                })
                .catch((err) => {
                    req.destroy();
                    reject(new Error(`Pipeline failed: ${err.message}`));
                });
        });

        req.on('error', (err: any) => {
            req.destroy();
            reject(new Error(`Request error: ${err.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });

    // --- 引入带延迟递增的指数退避重试 ---
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await attemptDownload();
        } catch (err: any) {
            if (attempt === MAX_RETRIES) {
                throw err; // 最后一次耗尽，抛出彻底失败
            }
            logger.warn(`[文件下载] 第 ${attempt} 次尝试失败 (${err.message})，等待重试... URL: ${url}`);
            await new Promise(r => setTimeout(r, 2000 * attempt)); // 等待 2s, 4s 后重试
        }
    }

    throw new Error("Download completely failed after retries.");
}

export async function getFileSize(url: string, proxy: string | undefined, userAgent: string | undefined, logger: Logger): Promise<number | null> {
    try {
        // 先尝试HEAD请求（标准方式）
        const headSize = await tryHeadRequest(url, proxy, userAgent, logger);
        if (headSize !== null) {
            return headSize;
        }

        // HEAD失败，尝试GET请求获取部分内容
        return await tryGetRequestForSize(url, proxy, userAgent, logger);
    } catch (e) {
        logger.warn(`获取文件大小失败: ${url}`, e);
        return null;
    }
}

async function tryHeadRequest(url: string, proxy: string | undefined, userAgent: string | undefined, logger: Logger): Promise<number | null> {
    return new Promise((resolve) => {
        const u = new URL(url);
        const agent = getProxyAgent(proxy, url);
        const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

        const headers: Record<string, string | undefined> = {'User-Agent': userAgent};
        if (u.hostname.includes('bilibili.com')) {
            headers['Referer'] = 'https://www.bilibili.com/';
        }

        const req = getter(url, {
            agent,
            method: 'HEAD',
            timeout: 5000,
            headers: headers
        }, (res: any) => {
            const len = res.headers['content-length'];
            if (len && /^\d+$/.test(len)) {
                resolve(parseInt(len, 10));
            } else {
                resolve(null);
            }
            req.destroy();
        });

        req.on('error', (err: any) => {
            logger.warn(`HEAD请求失败: ${url}`, err);
            req.destroy();
            resolve(null);
        });

        req.on('timeout', () => {
            logger.warn(`HEAD请求超时: ${url}`);
            req.destroy();
            resolve(null);
        });
    });
}

async function tryGetRequestForSize(url: string, proxy: string | undefined, userAgent: string | undefined, logger: Logger): Promise<number | null> {
    return new Promise((resolve) => {
        const u = new URL(url);
        const agent = getProxyAgent(proxy, url);
        const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

        const headers: Record<string, string | undefined> = {
            'User-Agent': userAgent,
            'Range': 'bytes=0-1023'
        };
        if (u.hostname.includes('bilibili.com')) {
            headers['Referer'] = 'https://www.bilibili.com/';
        }

        const req = getter(url, {
            agent,
            timeout: 5000,
            headers: headers
        }, (res: any) => {
            const contentRange = res.headers['content-range'];
            if (contentRange) {
                // 从 Content-Range 头获取总大小，例如: "bytes 0-1023/12345678"
                const match = contentRange.match(/\/(\d+)$/);
                if (match) {
                    resolve(parseInt(match[1], 10));
                    req.destroy();
                    return;
                }
            }

            const len = res.headers['content-length'];
            if (len && /^\d+$/.test(len)) {
                resolve(parseInt(len, 10));
            } else {
                resolve(null);
            }

            // 读取少量数据后关闭连接
            res.on('data', () => {
                req.destroy();
            });
        });

        req.on('error', (err: any) => {
            logger.warn(`GET请求获取大小失败: ${url}`, err);
            req.destroy();
            resolve(null);
        });

        req.on('timeout', () => {
            logger.warn(`GET请求获取大小超时: ${url}`);
            req.destroy();
            resolve(null);
        });
    });
}

/**
 * 会话设置的作用域标识：群聊取群号，私聊取频道标识 (如 `private:<userId>`)
 */
export function getSettingsScope(session: Session): string | undefined {
    return session.guildId || session.channelId;
}

export async function getEffectiveSettings(ctx: Context, scopeId: string | undefined, config: PluginConfig) {
    if (scopeId == undefined) {
        return {
            parsers: config.default_parsers,
            nsfw: config.allow_sensitive
        };
    }

    const data = await ctx.database.get('sla_group_settings', scopeId);
    const record = data[0]

    // 合并：自定义设置覆盖默认
    const effectiveParsers = {...config.default_parsers, ...record?.custom_parsers ? record.custom_parsers : {}};
    const nsfw_enabled = record?.nsfw_enabled ? record.nsfw_enabled : config.allow_sensitive;
    return {
        parsers: effectiveParsers,
        nsfw: nsfw_enabled
    };
}

export async function isUserAdmin(session: Session, userId: string): Promise<boolean> {
    if (!session.guildId) return false;

    // 使用 (session.user as any) 来规避类型检查，同时保留可选链以防 user 为空
    if ((session.user as any)?.authority >= 3) return true;

    try {
        const memberInfo = await session.bot.getGuildMember(session.guildId, userId);
        if (!memberInfo) return false;

        const adminRoles = ["owner", "admin", "administrator"];
        const memberRoles = (memberInfo.roles || []).map(r => r.name).filter((n): n is string => !!n);

        for (const role of memberRoles) {
            if (adminRoles.includes(role.toLowerCase())) return true;
        }
        return false;
    } catch (error) {
        return true;
    }
}

function hasOneBotForwardSupport(session: Session): boolean {
    return Boolean((session as any).onebot && typeof (session as any).onebot._request === 'function');
}

export async function sendResult(
    ctx: Context,
    session: Session,
    config: PluginConfig,
    result: ParsedInfo,
    logger: Logger,
    statsRef: {
        downloadTime: number,
        sendTime: number,
        errors: string[],
        fileCacheHits?: number,
        fileCacheMisses?: number
    }
): Promise<void> {
    if (config.enableCache && config.usingLocal) {
        const availability = await getLocalCacheAvailability(ctx, result);
        if (availability.total > 0) {
            result._cache = {
                ...result._cache,
                file: `命中 ${availability.hits}/${availability.total}`
            };
        }
    }

    if ((config.useForward === 'forward' || config.useForward === 'mixed') && !hasOneBotForwardSupport(session)) {
        logger.warn(`当前会话没有 OneBot forward API，${config.useForward} 模式回退到 plain。`);
        await sendResult_plain(ctx, session, config, result, logger, statsRef);
        return;
    }

    switch (config.useForward) {
        case "plain":
            await sendResult_plain(ctx, session, config, result, logger, statsRef);
            break;
        case 'forward':
            await sendResult_forward(ctx, session, config, result, logger, false, statsRef);
            break;
        case "mixed":
            await sendResult_forward(ctx, session, config, result, logger, true, statsRef);
            break;
    }
}

function collectResultRemoteUrls(result: ParsedInfo): Array<{ url: string, cacheKey?: string }> {
    const entries = new Map<string, { url: string, cacheKey?: string }>();
    if (result.coverUrl) entries.set(`url:${result.coverUrl}`, {url: result.coverUrl});
    if (result.mainbody) {
        for (const match of result.mainbody.matchAll(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/gi)) {
            entries.set(`url:${match[1]}`, {url: match[1]});
        }
    }
    if (Array.isArray(result.files)) {
        for (const file of result.files) {
            if (file?.url) {
                const key = file.cacheKey ? `cache:${file.cacheKey}` : `url:${file.url}`;
                entries.set(key, {url: file.url, cacheKey: file.cacheKey});
            }
        }
    }
    return [...entries.values()].filter(entry => /^https?:\/\//i.test(entry.url));
}

async function getLocalCacheAvailability(ctx: Context, result: ParsedInfo): Promise<{ total: number, hits: number }> {
    const urls = collectResultRemoteUrls(result);
    let hits = 0;
    for (const entry of urls) {
        if (await findExistingFileCache(ctx, entry.url, entry.cacheKey)) {
            hits++;
        }
    }
    return {total: urls.length, hits};
}

async function getCachedFileSize(ctx: Context, url: string, cacheKey?: string): Promise<number | null> {
    const cached = await findExistingFileCache(ctx, url, cacheKey);
    if (!cached) return null;

    try {
        const stat = await fs.promises.stat(cached.path);
        return stat.size;
    } catch {
        return null;
    }
}

function buildCachePlaceholder(result: ParsedInfo, statsRef: {
    fileCacheHits?: number,
    fileCacheMisses?: number
}): string {
    const lines: string[] = [];
    if (result._cache?.parse) lines.push(`解析缓存: ${result._cache.parse}`);
    if (result._cache?.file) {
        lines.push(`文件缓存: ${result._cache.file}`);
    } else if ((statsRef.fileCacheHits || 0) > 0 || (statsRef.fileCacheMisses || 0) > 0) {
        lines.push(`文件缓存: 命中 ${statsRef.fileCacheHits || 0} / 新下载 ${statsRef.fileCacheMisses || 0}`);
    }
    return lines.join('\n');
}

export async function sendResult_plain(
    ctx: Context,
    session: Session,
    config: PluginConfig,
    result: ParsedInfo,
    logger: Logger,
    statsRef: {
        downloadTime: number,
        sendTime: number,
        errors: string[],
        fileCacheHits?: number,
        fileCacheMisses?: number
    }
): Promise<void> {
    logger.debug('进入普通发送');

    const localDownloadDir = config.localDownloadDir;
    const onebotReadDir = config.onebotReadDir;

    let mediaCoverUrl = result.coverUrl;
    let mediaMainbody = result.mainbody;

    let proxy = undefined;
    if (config.proxy_settings[result.platform as keyof typeof config.proxy_settings]) {
        proxy = config.proxy;
        logger.debug("正在使用代理");
    }

    // --- 下载封面 ---
    if (result.coverUrl) {
        if (config.usingLocal) {
            const t = Date.now(); // 计时开始
            try {
                mediaCoverUrl = await downloadAndMapUrl(ctx, result.coverUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger, config.enableCache, statsRef);
                logger.debug(`封面已下载: ${mediaCoverUrl}`);
            } catch (e: any) {
                logger.warn(`封面下载失败: ${result.coverUrl}`, e);
                statsRef.errors.push(`[Cover] ${e.message}`);
                mediaCoverUrl = result.coverUrl;
            }
            statsRef.downloadTime += Date.now() - t; // 累加耗时
        } else {
            mediaCoverUrl = result.coverUrl
        }
    }

    // --- 下载 mainbody 中的图片 ---
    if (result.mainbody && config.usingLocal) {
        const t = Date.now(); // 计时开始
        const imgMatches = [...result.mainbody.matchAll(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/gi)];
        const urlMap: Record<string, string> = {};

        await Promise.all(
            imgMatches.map(async (match) => {
                const remoteUrl = match[1];
                if (config.usingLocal) {
                    try {
                        const localUrl = await downloadAndMapUrl(ctx, remoteUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger, config.enableCache, statsRef);
                        urlMap[remoteUrl] = localUrl;
                        logger.debug(`正文图片已下载: ${localUrl}`);
                    } catch (e: any) {
                        logger.warn(`正文图片下载失败: ${remoteUrl}`, e);
                        statsRef.errors.push(`[Mainbody Image] ${e.message}`);
                    }
                } else {
                    urlMap[remoteUrl] = remoteUrl
                }
            })
        );
        statsRef.downloadTime += Date.now() - t; // 累加耗时

        mediaMainbody = result.mainbody;
        for (const [remote, local] of Object.entries(urlMap)) {
            const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            mediaMainbody = mediaMainbody.replace(new RegExp(escaped, 'g'), local);
        }
    }

    // === 模板替换 ===
    let message = config.format;
    message = message.replace(/{title}/g, escapeHtml(result.title || ''));
    message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
    message = message.replace(/{mainbody}/g, mediaMainbody ?? '');
    message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
    message = message.replace(/{cover}/g, mediaCoverUrl ? h.image(mediaCoverUrl).toString() : '');
    message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));
    message = message.replace(/{cache}/g, escapeHtml(buildCachePlaceholder(result, statsRef)));

    // 清理空行
    const cleanMessage = message.split('\n').filter(line => line.trim() !== '' || line.includes('<')).join('\n');

    logger.debug(`解析结果: \n ${JSON.stringify(result, null, 2)}`);

    const sendPromises: Promise<any>[] = [];

    // 发送主消息
    if (cleanMessage) {
        sendPromises.push(session.send(h.quote(session.messageId) + cleanMessage));
    }

    // --- 发送 files 中的所有媒体（video/audio/generic）---
    if (Array.isArray(result.files)) {
        for (const file of result.files) {
            const {type, url: remoteUrl, cacheKey} = file;
            if (!['video', 'audio', 'generic'].includes(type)) continue;

            // 权限分离校验
            const isVideo = type === 'video';
            const isAudio = type === 'audio';
            const isGeneric = type === 'generic';

            const needsFile = config.sendFiles && (isVideo || isGeneric || isAudio);
            const needsVoice = config.sendVoice && isAudio;

            // 如果两个通道都没开启，直接跳过
            if (!needsFile && !needsVoice) continue;

            let shouldSend = true;
            if (config.Max_size !== undefined) {
                const t = Date.now();
                let sizeBytes = config.usingLocal && config.enableCache
                    ? await getCachedFileSize(ctx, remoteUrl, cacheKey)
                    : null;
                if (sizeBytes === null) {
                    sizeBytes = await getFileSize(remoteUrl, proxy, config.userAgent, logger);
                }
                statsRef.downloadTime += Date.now() - t;

                const maxBytes = config.Max_size * 1024 * 1024;

                if (sizeBytes === null) {
                    shouldSend = false;
                    sendPromises.push(session.send(`无法获取文件大小，已跳过发送`));
                    logger.info(`获取文件大小失败，放弃发送: ${remoteUrl}`);
                } else if (sizeBytes > maxBytes) {
                    shouldSend = false;
                    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                    const maxMB = config.Max_size.toFixed(2);
                    sendPromises.push(session.send(`文件大小超限 (${sizeMB} MB > ${maxMB} MB)`));
                    logger.debug(`文件大小超限 (${sizeMB} MB > ${maxMB} MB)，跳过: ${remoteUrl}`);
                }
            }

            if (shouldSend) {
                try {
                    let localUrl = remoteUrl;
                    if (config.usingLocal) {
                        const t = Date.now();
                        localUrl = await downloadAndMapUrl(ctx, remoteUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger, config.enableCache, statsRef, cacheKey);
                        statsRef.downloadTime += Date.now() - t;
                    }

                    if (!localUrl) continue;

                    // 1. 发送【文件通道】(如果开启了文件发送)
                    if (needsFile) {
                        let fileElement: string | null = null;
                        if (isVideo) {
                            fileElement = h.video(localUrl).toString();
                        } else if (isAudio || isGeneric) {
                            fileElement = h.file(localUrl).toString(); // 音频和通用文件都用 file 发送
                        }
                        if (fileElement) sendPromises.push(session.send(fileElement));
                    }

                    // 2. 发送【语音通道】(如果开启了语音发送)
                    if (needsVoice) {
                        sendPromises.push(session.send(h.audio(localUrl).toString()));
                    }

                    logger.debug(`${type} 直链处理完毕 (${result.platform}): ${remoteUrl}`);
                } catch (e: any) {
                    logger.warn(`${type} 下载/发送失败: ${remoteUrl}`, e);
                    statsRef.errors.push(`[File ${type}] ${e.message}`);
                }
            }
        }
    }

    const wrappedSendPromises = sendPromises.map(p =>
        p.catch((e: any) => {
            const errorMsg = e.message || String(e);
            if (errorMsg.includes('Timeout')) {
                logger.warn(`普通发送请求触发超时，已作放行处理屏蔽此报错。`);
                return Promise.resolve();
            }
            throw e;
        })
    );
    const tSend = Date.now(); // 发送计时开始
    await Promise.all(wrappedSendPromises);
    statsRef.sendTime = Date.now() - tSend; // 计算发送耗时
}

export async function sendResult_forward(
    ctx: Context,
    session: Session,
    config: PluginConfig,
    result: ParsedInfo,
    logger: Logger,
    mixed_sending = false,
    statsRef: {
        downloadTime: number,
        sendTime: number,
        errors: string[],
        fileCacheHits?: number,
        fileCacheMisses?: number
    }
): Promise<void> {
    logger.debug(mixed_sending ? '进入混合发送' : '进入合并发送');

    if (!hasOneBotForwardSupport(session)) {
        logger.warn(`当前会话没有 OneBot forward API，${mixed_sending ? 'mixed' : 'forward'} 模式回退到 plain。`);
        await sendResult_plain(ctx, session, config, result, logger, statsRef);
        return;
    }

    const localDownloadDir = config.localDownloadDir;
    const onebotReadDir = config.onebotReadDir;

    let mediaCoverUrl = result.coverUrl;
    let mediaMainbody = unescapeHtml(result.mainbody ?? '');

    let proxy = undefined;
    if (config.proxy_settings[result.platform as keyof typeof config.proxy_settings]) {
        proxy = config.proxy;
        logger.debug("正在使用代理");
    }

    // --- 封面 ---
    if (result.coverUrl) {
        if (config.usingLocal) {
            const t = Date.now();
            try {
                mediaCoverUrl = await downloadAndMapUrl(ctx, result.coverUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger, config.enableCache, statsRef);
            } catch (e: any) {
                logger.warn('封面下载失败', e);
                statsRef.errors.push(`[Cover] ${e.message}`);
                mediaCoverUrl = '';
            }
            statsRef.downloadTime += Date.now() - t;
        } else {
            mediaCoverUrl = result.coverUrl
        }
    }

    // --- mainbody 图片 ---
    if (mediaMainbody) {
        const imgUrls = [...mediaMainbody.matchAll(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/gi)].map(m => m[1]);
        const urlMap: Record<string, string> = {};

        await Promise.all(imgUrls.map(async (url) => {
                if (config.usingLocal) {
                    const t = Date.now();
                    try {
                        // 去重下载
                        if (!urlMap[url]) {
                            urlMap[url] = await downloadAndMapUrl(ctx, url, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger, config.enableCache, statsRef);
                        }
                    } catch (e: any) {
                        logger.warn(`正文图片下载失败: ${url}`, e);
                        statsRef.errors.push(`[Mainbody Image] ${e.message}`);
                    }
                    statsRef.downloadTime += Date.now() - t;
                } else {
                    urlMap[url] = url
                }
            }
        ));

        for (const [remote, local] of Object.entries(urlMap)) {
            const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            mediaMainbody = mediaMainbody.replace(new RegExp(escaped, 'g'), local);
        }
    }

    // === 主消息 ===
    let message = config.format;
    message = message.replace(/{title}/g, result.title || '');
    message = message.replace(/{authorName}/g, result.authorName || '');
    message = message.replace(/{sourceUrl}/g, result.sourceUrl || '');
    message = message.replace(/{stats}/g, result.stats || '');
    message = message.replace(/{cache}/g, buildCachePlaceholder(result, statsRef));

    const lines = message.split('\n').filter(line => line.trim() !== '');
    const mainSegments: any[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLastLine = i === lines.length - 1;
        const tokens = line.split(/(\{cover\})/g);
        const currentLineSegments: any[] = [];
        let hasTextContent = false;

        for (const token of tokens) {
            if (token === '{cover}') {
                if (mediaCoverUrl) {
                    currentLineSegments.push({type: 'image', data: {file: mediaCoverUrl}});
                }
            } else if (token === '{mainbody}') {
                const parsed = parseHtmlToSegments(mediaMainbody || '');
                currentLineSegments.push(...parsed);
                hasTextContent = parsed.some(seg => seg.type === 'text');
            } else if (token.trim() !== '') {
                currentLineSegments.push({type: 'text', data: {text: token}});
                hasTextContent = true;
            }
        }

        if (currentLineSegments.length > 0) {
            mainSegments.push(...currentLineSegments);
        }
        if (!isLastLine && hasTextContent) {
            mainSegments.push({type: 'text', data: {text: '\n'}});
        }
    }

    const forwardNodes: any[] = [];
    if (mainSegments.length > 0) {
        forwardNodes.push({
            type: 'node',
            data: {
                user_id: session.selfId,
                nickname: '分享助手',
                content: mainSegments
            }
        });
    }

    // --- 处理 files ---
    const extraSendPromises: Promise<any>[] = [];

    if (Array.isArray(result.files)) {
        for (const file of result.files) {
            const {type, url: remoteUrl, cacheKey} = file;
            if (!['video', 'audio', 'generic'].includes(type)) continue;

            // 权限分离校验
            const isVideo = type === 'video';
            const isAudio = type === 'audio';
            const isGeneric = type === 'generic';

            const needsFile = config.sendFiles && (isVideo || isGeneric || isAudio);
            const needsVoice = config.sendVoice && isAudio;

            if (!needsFile && !needsVoice) continue;

            let shouldInclude = true;
            if (config.Max_size !== undefined) {
                const t = Date.now();
                let sizeBytes = config.usingLocal && config.enableCache
                    ? await getCachedFileSize(ctx, remoteUrl, cacheKey)
                    : null;
                if (sizeBytes === null) {
                    sizeBytes = await getFileSize(remoteUrl, proxy, config.userAgent, logger);
                }
                statsRef.downloadTime += Date.now() - t;

                const maxBytes = config.Max_size * 1024 * 1024;

                if (sizeBytes === null) {
                    shouldInclude = false;
                    logger.warn(`获取文件大小失败，放弃发送: ${remoteUrl}`);
                    forwardNodes.push({
                        type: 'node',
                        data: {
                            user_id: session.selfId,
                            nickname: '分享助手',
                            content: {type: 'text', data: {text: `无法获取文件大小，已跳过发送`}}
                        }
                    });
                } else if (sizeBytes > maxBytes) {
                    shouldInclude = false;
                    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                    const maxMB = config.Max_size.toFixed(2);
                    forwardNodes.push({
                        type: 'node',
                        data: {
                            user_id: session.selfId,
                            nickname: '分享助手',
                            content: {type: 'text', data: {text: `文件大小超限 (${sizeMB} MB > ${maxMB} MB)`}}
                        }
                    });
                    logger.debug(`文件大小超限 (${sizeMB} MB > ${maxMB} MB)，跳过: ${remoteUrl}`);
                }
            }

            if (shouldInclude) {
                try {
                    let localUrl = remoteUrl;
                    if (config.usingLocal) {
                        const t = Date.now();
                        localUrl = await downloadAndMapUrl(ctx, remoteUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger, config.enableCache, statsRef, cacheKey);
                        statsRef.downloadTime += Date.now() - t;
                    }
                    if (!localUrl) continue;

                    // 1. 发送【文件通道】
                    if (needsFile) {
                        if (mixed_sending) {
                            // 混合模式，丢到外侧独立发送
                            if (isVideo) extraSendPromises.push(session.send(h.video(localUrl).toString()));
                            else extraSendPromises.push(session.send(h.file(localUrl).toString())); // 音频与文件都发 file
                        } else {
                            // 纯转发模式，塞进转发节点内
                            if (isVideo) {
                                forwardNodes.push({
                                    type: 'node',
                                    data: {
                                        user_id: session.selfId,
                                        nickname: '分享助手',
                                        content: [{type: 'video', data: {file: localUrl}}]
                                    }
                                });
                            } else {
                                forwardNodes.push({
                                    type: 'node',
                                    data: {
                                        user_id: session.selfId,
                                        nickname: '分享助手',
                                        content: [{type: 'file', data: {file: localUrl}}]
                                    }
                                });
                            }
                        }
                    }

                    // 2. 发送【语音通道】
                    if (needsVoice) {
                        if (config.sendVoiceOutside || mixed_sending) {
                            // 在外部独立发语音条
                            extraSendPromises.push(session.send(h.audio(localUrl).toString()));
                        } else {
                            // 塞进合并转发节点内
                            forwardNodes.push({
                                type: 'node',
                                data: {
                                    user_id: session.selfId,
                                    nickname: '分享助手',
                                    content: [{type: 'audio', data: {file: localUrl}}]
                                }
                            });
                        }
                    }

                    logger.debug(`${type} 直链处理完毕 (${result.platform}): ${remoteUrl}`);
                } catch (e: any) {
                    logger.warn(`${type} 处理失败: ${remoteUrl}`, e);
                    statsRef.errors.push(`[File ${type}] ${e.message}`);
                }
            }
        }
    }

    if (config.sendLinks && Array.isArray(result.files)) {
        for (const file of result.files) {
            const {type, url: Url} = file;

            forwardNodes.push({
                type: 'node',
                data: {
                    user_id: session.selfId,
                    nickname: '分享助手',
                    content: [{type: 'text', data: {text: `${type}: ${Url}`}}]
                }
            });
        }
    }

    if (forwardNodes.length === 0 && extraSendPromises.length === 0) return

    logger.debug(`解析结果: \n ${JSON.stringify(result, null, 2)}`);

    const promises: Promise<any>[] = [];
    const onebot = (session as any).onebot;

    let sendTo: {}
    if (session.channel) {
        sendTo = {group_id: session.guildId}
    } else {
        sendTo = {user_id: session.userId}
    }

    if (forwardNodes.length > 0) {
        const forwardPromise = onebot._request('send_forward_msg', {
            ...sendTo,
            messages: forwardNodes,
            news: [
                {text: mediaMainbody || '-'},
                {text: '点击查看详情 | Powered by furryaxw'},
                {text: result.sourceUrl || ''}
            ],
            prompt: result.title || '',
            summary: '分享解析',
            source: result.title || ''
        }).catch((e: any) => {
            const errorMsg = e.message || String(e);
            if (errorMsg.includes('Timeout') && errorMsg.includes('send_forward_msg')) {
                logger.warn(`合并转发请求触发超时，已作放行处理屏蔽此报错。`);
                return Promise.resolve();
            }
            throw e;
        });

        promises.push(forwardPromise);
    }

    // 混合模式额外消息
    if (mixed_sending && extraSendPromises.length > 0) {
        const wrappedExtraPromises = extraSendPromises.map(p =>
            p.catch(e => {
                const errorMsg = e.message || String(e);
                if (errorMsg.includes('Timeout')) {
                    logger.warn(`混合发送请求触发超时，已作放行处理屏蔽此报错。`);
                    return Promise.resolve();
                }
                throw e;
            })
        );
        promises.push(...wrappedExtraPromises);
    }

    if (promises.length > 0) {
        const tSend = Date.now();
        await Promise.all(promises);
        statsRef.sendTime = Date.now() - tSend;
    }
}
