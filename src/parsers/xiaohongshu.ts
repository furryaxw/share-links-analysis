// src/parsers/xiaohongshu.ts

import {Context, h, Logger, Session} from 'koishi';
import {FileInfo, Link, ParsedInfo, PluginConfig, XhsInitialState} from '../types';
// @ts-ignore
import {Cookie, Page} from 'puppeteer';
import {load} from 'cheerio';
import {escapeHtml, getCookie, numeral} from '../utils';

export const name = "xiaohongshu";

export function getFileCacheKey(url: string, noteId?: string): string | null {
    try {
        const u = new URL(url);
        return noteId ? `xiaohongshu:${noteId}:${u.pathname}` : `xiaohongshu:${u.pathname}`;
    } catch {
        return noteId ? `xiaohongshu:${noteId}` : null;
    }
}

function createXhsVideoFile(noteId: string, url: string): FileInfo {
    const cacheKey = getFileCacheKey(url, noteId);
    return cacheKey ? {type: 'video', url, cacheKey} : {type: 'video', url};
}

const linkRules = [
    {
        pattern: /(?:https?:\/\/)?www\.xiaohongshu\.com\/discovery\/item\/([a-zA-Z0-9_-]+)(?:[^"'\s]*)/gi,
        type: "discovery" as const,
    },
    {
        pattern: /(?:https?:\/\/)?www\.xiaohongshu\.com\/explore\/([a-zA-Z0-9_-]+)(?:[^"'\s]*)/gi,
        type: "explore" as const,
    },
    {
        pattern: /(?:https?:\/\/)?xhslink\.com\/(?:\w\/)?([a-zA-Z0-9]+)\b/gi,
        type: "short" as const,
    },
];

/**
 * 在文本中匹配小红书链接 (长链接或短链接)
 */
export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();
    const initialLinks: Link[] = [];

    for (const {pattern, type} of linkRules) {
        let m;
        pattern.lastIndex = 0;
        while ((m = pattern.exec(content)) !== null) {
            const idPart = m[1];
            if (!idPart) continue;
            const cleanId = idPart.split('?')[0];
            let url = m[0];
            if (!url.startsWith('http')) {
                url = `https://${url}`;
            }
            // 分享链接的追踪参数不进入后续请求、日志与去重键
            url = buildNoteUrl(url, parseNoteLink(url).xsecToken);
            initialLinks.push({platform: name, type, id: cleanId, url});
        }
    }

    const logger = ctx.logger(`share-links-analysis:${name}`);
    const proxy = config.proxy_settings[name] ? config.proxy : undefined;

    for (const link of initialLinks) {
        let finalLink = link;

        if (link.type === 'short') {
            // 短链只需第一跳的 Location，里面带着笔记地址与 xsec_token
            const resolved = await resolveShareLink(ctx, link.url, config, logger, proxy);
            if (resolved.noteId) {
                finalLink = {platform: name, type: 'explore', id: resolved.noteId, url: resolved.noteUrl};
            }
        }

        const key = `${finalLink.type}:${finalLink.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            results.push(finalLink);
        }
    }
    return results;
}

/**
 * 使用 Puppeteer 刷新小红书 Cookie 并存入数据库
 * @param ctx - Koishi Context
 * @param config
 */
export async function lc_get_cookie(ctx: Context, config: PluginConfig): Promise<string> {
    const logger = ctx.logger('share-links-analysis:xiaohongshu');

    if (!ctx.puppeteer) {
        logger.warn('Puppeteer 服务未启用，无法自动刷新 Cookie。');
        return "";
    }

    logger.info('正在执行两步导航策略以刷新小红书 Cookie...');
    let page: Page | null = null;
    try {
        page = await ctx.puppeteer.page();
        await page.setUserAgent(config.userAgent);

        // --- 步骤 1: 访问首页，获取基础会话 Cookie (如 web_session) ---
        logger.info('步骤 1/2: 访问首页以获取初始会话 Cookie...');
        try {
            await page.goto('https://www.xiaohongshu.com/', {
                waitUntil: 'load',
                timeout: 10000
            });
        } catch (error) {
        }
        const initialCookies = await page.cookies();
        logger.info(`步骤 1 完成, 获取到 ${initialCookies.length} 个初始 Cookie。`);

        // --- 步骤 2: 访问 /explore 页面，触发反爬虫验证，获取安全 Cookie ---
        logger.info('步骤 2/2: 访问 /explore 页面以触发并获取安全 Cookie...');
        try {
            await page.goto('https://www.xiaohongshu.com/explore', {
                waitUntil: 'load',
                timeout: 10000
            });
        } catch (error) {
        }

        // --- 步骤 3: 收集并验证最终合并的 Cookie ---
        const finalCookies = await page.cookies();
        if (finalCookies.length === 0) {
            logger.warn('执行两步导航后，仍未能获取到任何 Cookie。');
            return "";
        }

        const hasWebSession = finalCookies.some((c: Cookie) => c.name === 'web_session');
        const hasABRequestId = finalCookies.some((c: Cookie) => c.name === 'abRequestId');

        logger.info(`步骤 2 完成, 共获取到 ${finalCookies.length} 个最终 Cookie。`);
        logger.info(`- 是否包含 'web_session': ${hasWebSession ? '是' : '否'}`);
        logger.info(`- 是否包含 'abRequestId': ${hasABRequestId ? '是' : '否'}`);

        if (!hasWebSession || !hasABRequestId) {
            logger.warn('关键 Cookie 缺失，本次刷新可能不完整。将放弃刷新。');
            return "";
        }

        // 在这里过滤掉 acw_tc
        const filteredCookies = finalCookies.filter((c: Cookie) => c.name !== 'acw_tc');

        // 使用过滤后的 cookie 数组来生成字符串
        const cookieString = filteredCookies.map((c: Cookie) => `${c.name}=${c.value}`).join('; ');

        logger.info('成功执行两步刷新策略并缓存了小红书 Cookie！');
        return cookieString;
    } catch (error) {
        logger.error('在执行两步导航刷新 Cookie 时发生错误: ', error);
        return "";
    } finally {
        if (page) {
            await page.close();
        }
    }
}

/**
 * 从分享链接中解析出笔记 ID 与完整笔记地址。
 * 短链只跟随第一跳 (xhslink.com 的 Location 里已经带着完整地址和 token)，不需要登录态。
 */
async function resolveShareLink(
    ctx: Context,
    url: string,
    config: PluginConfig,
    logger: Logger,
    proxy?: string
): Promise<{noteId?: string; xsecToken?: string; noteUrl: string}> {
    const direct = parseNoteLink(url);
    if (direct.noteId) return {...direct, noteUrl: url};

    try {
        const options: any = {
            method: 'GET',
            redirect: 'manual',
            headers: {'User-Agent': config.userAgent},
        };
        if (proxy) options.proxyAgent = proxy;
        const response = await ctx.http(url, options);
        const location = (response.headers as any)?.get?.('location');
        if (location) {
            const noteUrl = new URL(String(location), url).toString();
            const parsed = parseNoteLink(noteUrl);
            if (parsed.noteId) return {...parsed, noteUrl};
        }
        logger.debug(`短链未返回可识别的笔记地址: ${url}`);
    } catch (error: any) {
        logger.debug(`展开短链失败: ${url} - ${error.message}`);
    }
    return {noteUrl: url};
}

/** 从笔记地址里取出笔记 ID 与 xsec_token */
function parseNoteLink(url: string): {noteId?: string; xsecToken?: string} {
    try {
        const parsed = new URL(url.replace(/&amp;/g, '&'));
        return {
            noteId: parsed.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1],
            xsecToken: parsed.searchParams.get('xsec_token') || undefined,
        };
    } catch (e) {
        // 不是标准 URL 时按未解析处理
        return {};
    }
}

/** 分享链接里的追踪参数既不带到请求上，也不带到 sourceUrl，只保留笔记地址与 xsec_token */
function buildNoteUrl(noteUrl: string, xsecToken?: string): string {
    try {
        const target = new URL(noteUrl);
        target.search = '';
        if (xsecToken) target.searchParams.set('xsec_token', xsecToken);
        return target.toString();
    } catch (e) {
        return noteUrl;
    }
}

// 小红书对非浏览器客户端会直接跳登录页，但页面本身（SSR 数据）不需要登录态，
// 因此常驻一个浏览器页面，用它做同源请求拿页面内容。
let transportPage: Page | null = null;
let injectedCookie = '';

async function getTransportPage(ctx: Context, config: PluginConfig, logger: Logger): Promise<Page> {
    if (transportPage && !transportPage.isClosed()) return transportPage;

    const page = await ctx.puppeteer.page();
    await page.setUserAgent(config.userAgent);

    const cookieStr = await getCookie(ctx, config, name);
    if (cookieStr) {
        const cookies = cookieStr.split(';').map((pair) => {
            const [cookieName, ...cookieValue] = pair.trim().split('=');
            return {name: cookieName, value: cookieValue.join('='), domain: '.xiaohongshu.com'};
        }).filter(cookie => cookie.name);
        if (cookies.length > 0) await page.setCookie(...cookies as any);
        injectedCookie = cookieStr;
    }

    await page.goto('https://www.xiaohongshu.com/explore', {waitUntil: 'domcontentloaded', timeout: 20000});
    logger.debug('小红书请求页面已就绪');
    transportPage = page;
    return page;
}

/**
 * 借浏览器内核取笔记页 HTML：Node 直连会被风控打到登录页，浏览器指纹的同源请求则正常返回
 */
async function fetchNoteHtml(ctx: Context, config: PluginConfig, logger: Logger, noteUrl: string): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const page = await getTransportPage(ctx, config, logger);

            const cookieStr = await getCookie(ctx, config, name);
            if (cookieStr && cookieStr !== injectedCookie) {
                const cookies = cookieStr.split(';').map((pair) => {
                    const [cookieName, ...cookieValue] = pair.trim().split('=');
                    return {name: cookieName, value: cookieValue.join('='), domain: '.xiaohongshu.com'};
                }).filter(cookie => cookie.name);
                if (cookies.length > 0) await page.setCookie(...cookies as any);
                injectedCookie = cookieStr;
            }

            const result = await page.evaluate(async (target: string) => {
                const response = await fetch(target, {credentials: 'include'});
                return {status: response.status, url: response.url, text: await response.text()};
            }, noteUrl);

            if (result.status >= 400) throw new Error(`页面返回状态码 ${result.status}`);
            if (result.url.includes('/login')) throw new Error('被跳转到登录页');
            if (result.url.includes('/404')) throw new Error('笔记页面不存在：链接缺少 xsec_token 或笔记已被删除');
            return result.text;
        } catch (error: any) {
            lastError = error;
            logger.debug(`获取小红书页面失败 (第 ${attempt} 次): ${error.message}`);
            if (transportPage) {
                try {
                    await transportPage.close();
                } catch (e) {
                }
                transportPage = null;
                injectedCookie = '';
            }
        }
    }
    throw lastError ?? new Error('获取小红书页面失败');
}

/**
 * 短链兜底：页面内 fetch 到 xhslink.com 属跨源会被拦，改为直接导航，
 * 再从最终地址里取出带 xsec_token 的笔记地址。
 */
async function followShortLink(ctx: Context, config: PluginConfig, logger: Logger, shortUrl: string): Promise<{noteId?: string; xsecToken?: string; noteUrl: string}> {
    const page = await getTransportPage(ctx, config, logger);
    await page.goto(shortUrl, {waitUntil: 'domcontentloaded', timeout: 20000});

    const finalUrl = page.url();
    const parsed = parseNoteLink(finalUrl);
    if (!parsed.noteId) {
        throw new Error(`短链未指向笔记页面（${finalUrl}），可能已失效或不是分享链接`);
    }
    logger.debug(`短链已跳转到: ${finalUrl}`);
    return {...parsed, noteUrl: finalUrl};
}

export async function init(ctx: Context, config: PluginConfig) {
    ctx.on('dispose', () => {
        transportPage?.close().catch(() => undefined);
        transportPage = null;
        injectedCookie = '';
    });
}

/**
 * 处理单个小红书链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @param session
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    const proxy = config.proxy_settings[name] ? config.proxy : undefined;

    // 步骤一：解析笔记地址（短链会解析出带 xsec_token 的真实笔记地址）
    const resolved = await resolveShareLink(ctx, link.url, config, logger, proxy);
    let noteId = resolved.noteId ?? link.id;
    let xsecToken = resolved.xsecToken;
    let noteUrl = resolved.noteUrl;

    // 步骤二：取笔记页 HTML 并解析页面数据
    let responseHtml: string;
    try {
        if (!resolved.noteId) {
            // Node 侧拿不到跳转目标时交给浏览器跟随短链跳转
            const followed = await followShortLink(ctx, config, logger, link.url);
            noteUrl = followed.noteUrl;
            noteId = followed.noteId ?? noteId;
            xsecToken = followed.xsecToken ?? xsecToken;
        }
        // 请求与 sourceUrl 都只保留笔记地址与 xsec_token，不带分享链接的追踪参数
        noteUrl = buildNoteUrl(noteUrl, xsecToken);
        logger.debug(`正在获取小红书笔记页: ${noteUrl}`);
        responseHtml = await fetchNoteHtml(ctx, config, logger, noteUrl);
    } catch (error: any) {
        logger.error(`获取小红书页面失败: ${error.message}`);
        return null;
    }

    try {
        const $ = load(responseHtml);
        const scriptContent = $('script:contains("window.__INITIAL_STATE__")').html();

        if (!scriptContent) {
            logger.error('在页面中未找到 __INITIAL_STATE__ 数据块，可能是token无效或小红书策略变更。');
            return null;
        }

        const jsonStr = scriptContent.replace(/window\.__INITIAL_STATE__\s*=\s*/, '').replace(/undefined/g, 'null');
        const pageData = JSON.parse(jsonStr) as XhsInitialState;
        const noteKey = Object.keys(pageData.note?.noteDetailMap ?? {})[0];
        if (!noteKey) {
            logger.error('无法在页面数据中找到笔记详情。');
            return null;
        }
        const noteData = pageData.note.noteDetailMap[noteKey].note;

        // --- 构建结构化数据 ---
        let videoUrl: string | null = null;
        let coverUrl: string | undefined = undefined;
        const images: string[] = [];

        if (noteData.type === 'video' && noteData.video) {
            logger.debug(`[XHS Video Debug] 发现视频笔记，视频数据对象: \n${JSON.stringify(noteData.video, null, 2)}`);
            if (noteData.video.media?.stream?.h264?.[0]?.masterUrl) {
                videoUrl = noteData.video.media.stream.h264[0].masterUrl;
                logger.debug(`[XHS Video Debug] 已提取视频链接: ${videoUrl}`);
            } else {
                logger.warn('[XHS Video Debug] 未能从预期路径 `note.video.media.stream.h264[0].masterUrl` 找到视频链接。');
            }

            if (noteData.imageList && noteData.imageList.length > 0) {
                coverUrl = noteData.imageList[0].infoList.find(i => i.imageScene === 'WB_DETAIL_SHARE')?.url || noteData.imageList[0].infoList[1]?.url;
            }
        } else if (Array.isArray(noteData.imageList)) {
            noteData.imageList.forEach((img) => {
                const imageUrl = img.infoList.find((i) => i.imageScene === 'WB_DETAIL_SHARE')?.url || img.infoList[1]?.url || img.url_default;
                if (imageUrl) {
                    images.push(imageUrl);
                }
            });
        }

        const liked = numeral(parseInt(noteData.interactInfo.likedCount), config);
        const collected = numeral(parseInt(noteData.interactInfo.collectedCount), config);
        const comment = numeral(parseInt(noteData.interactInfo.commentCount), config);
        const shared = numeral(parseInt(noteData.interactInfo.shareCount), config);

        const statsString = `点赞: ${liked} | 收藏: ${collected} | 评论: ${comment} | 分享: ${shared}`;

        const tags = noteData.tagList?.map(t => `#${t.name}`).join(' ') || '';

        // 提取发布时间 (Time)
        let timeString = '';
        if (noteData.time) {
            const date = new Date(noteData.time);
            // 简单格式化为 YYYY-MM-DD HH:mm:ss
            timeString = `\n发布时间: ${date.toLocaleString('zh-CN', {hour12: false})}`;
        }

        // 组装 Mainbody
        const image = images.length > 0 ? images.map(img => h.image(img).toString()).join('\n') : '';
        // 将 描述 + 标签 + 时间 + 图片 组合
        const mainbody = `${escapeHtml(noteData.desc.trim())}\n\n${tags}${timeString}\n` + image;

        let files: FileInfo[] = [];
        if (videoUrl) {
            files = [createXhsVideoFile(noteId, videoUrl)];
        }

        return {
            platform: name,
            title: noteData.title,
            authorName: noteData.user.nickname,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: files,
            sourceUrl: noteUrl,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`解析小红书页面数据时失败: ${error.message}`);
        return null;
    }
}
