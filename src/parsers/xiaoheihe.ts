// src/parsers/xiaoheihe.ts

import {createHash, randomBytes} from 'crypto';
import {Context, h, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig, XiaoHeiHeLink, XiaoHeiHeTreeResponse} from '../types';
import {escapeHtml, numeral} from '../utils';

export const name = "xiaoheihe";

export function getFileCacheKey(url: string, linkId?: string): string | null {
    try {
        const u = new URL(url);
        return linkId ? `xiaoheihe:${linkId}:${u.pathname}` : `xiaoheihe:${u.pathname}`;
    } catch {
        return linkId ? `xiaoheihe:${linkId}` : null;
    }
}

function createXiaoHeiheVideoFile(linkId: string, url: string): { type: 'video', url: string, cacheKey?: string } {
    const cacheKey = getFileCacheKey(url, linkId);
    return cacheKey ? {type: 'video', url, cacheKey} : {type: 'video', url};
}

const linkRules = [
    {
        pattern: /(?:https?:\/\/)?(?:[\w-]+\.)?xiaoheihe\.cn\/v3\/bbs\/app\/api\/web\/share\?[^"'\s]*?\blink_id=([a-zA-Z0-9]+)/gi,
        type: "bbs_api" as const,
    },
    {
        pattern: /(?:https?:\/\/)?(?:[\w-]+\.)?xiaoheihe\.cn\/app\/bbs\/link\/([a-zA-Z0-9]+)/gi,
        type: "bbs" as const,
    }
];

export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();

    for (const rule of linkRules) {
        let match;
        rule.pattern.lastIndex = 0;
        while ((match = rule.pattern.exec(content)) !== null) {
            const id = match[1];
            if (id) {
                const key = `${rule.type}:${id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({platform: name, type: rule.type, id, url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`});
            }
        }
    }
    return results;
}

// ===== 接口签名 =====
// api.xiaoheihe.cn 的 hkey 只由 (接口路径, _time + 1, nonce) 决定，没有密钥：
// 三个映射串交错取前 20 个字符做 MD5，摘要前 5 位再映射一次，摘要后 6 位做一轮混淆后取模补成两位校验码。
const SIGN_ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';

function mixByte(value: number): number {
    return value & 128 ? ((value << 1) ^ 27) & 255 : value << 1;
}

function mix1(value: number): number {
    return mixByte(value) ^ value;
}

function mix2(value: number): number {
    return mix1(mixByte(value));
}

function mix3(value: number): number {
    return mix2(mix1(mixByte(value)));
}

function mix4(value: number): number {
    return mix3(value) ^ mix2(value) ^ mix1(value);
}

function scramble(codes: number[]): number[] {
    const next = [0, 0, 0, 0];
    next[0] = mix4(codes[0]) ^ mix3(codes[1]) ^ mix2(codes[2]) ^ mix1(codes[3]);
    next[1] = mix1(codes[0]) ^ mix4(codes[1]) ^ mix3(codes[2]) ^ mix2(codes[3]);
    next[2] = mix2(codes[0]) ^ mix1(codes[1]) ^ mix4(codes[2]) ^ mix3(codes[3]);
    next[3] = mix3(codes[0]) ^ mix2(codes[1]) ^ mix1(codes[2]) ^ mix4(codes[3]);
    codes[0] = next[0];
    codes[1] = next[1];
    codes[2] = next[2];
    codes[3] = next[3];
    return codes;
}

/** 按字符码取模映射到签名字母表，trimEnd 对应原实现里对字母表尾部的裁剪 */
function mapChars(source: string, trimEnd = 0): string {
    const alphabet = trimEnd ? SIGN_ALPHABET.slice(0, -trimEnd) : SIGN_ALPHABET;
    let result = '';
    for (let index = 0; index < source.length; index++) {
        result += alphabet[source.charCodeAt(index) % alphabet.length];
    }
    return result;
}

function interleave(parts: string[]): string {
    let result = '';
    const maxLength = Math.max(...parts.map(part => part.length));
    for (let index = 0; index < maxLength; index++) {
        for (const part of parts) {
            if (index < part.length) result += part[index];
        }
    }
    return result;
}

function createHkey(apiPath: string, time: number, nonce: string): string {
    const normalizedPath = '/' + apiPath.split('/').filter(Boolean).join('/') + '/';
    const seed = interleave([
        mapChars(String(time), 2),
        mapChars(normalizedPath),
        mapChars(nonce),
    ]).slice(0, 20);
    const digest = createHash('md5').update(seed).digest('hex');
    const checksum = scramble(digest.slice(-6).split('').map(char => char.charCodeAt(0)))
        .reduce((sum, value) => sum + value, 0) % 100;
    return mapChars(digest.slice(0, 5), 4) + String(checksum).padStart(2, '0');
}

function readTagName(tag: any): string {
    if (typeof tag === 'string') return tag.trim();
    return String(tag?.text ?? '').trim();
}

function decodeEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/gi, '&');
}

/**
 * 帖子正文是富文本块：一个 JSON 数组，每块的 text 是带 <p>/<img> 的 HTML，图片只存在于 HTML 里。
 * 返回拼好的正文（文字已转义、图片为 h.image）与按出现顺序收集的图片地址。
 */
function parseRichText(raw: any): {body: string, images: string[]} {
    let blocks: any[];
    if (Array.isArray(raw)) {
        blocks = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            blocks = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            blocks = [{text: raw}];
        }
    } else {
        blocks = [];
    }

    let body = '';
    const images: string[] = [];
    for (const block of blocks) {
        const html = typeof block?.text === 'string' ? block.text : '';
        if (!html) continue;

        for (const segment of html.split(/<\/p>|<br\s*\/?>/i)) {
            const imageUrl = segment.match(/<img[^>]+data-original=["']([^"']+)["']/i)?.[1]
                ?? segment.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];

            if (imageUrl) {
                const decoded = decodeEntities(imageUrl);
                images.push(decoded);
                body += h.image(decoded).toString();
                continue;
            }

            const text = decodeEntities(segment.replace(/<[^>]*>/g, '')).trim();
            if (text) body += escapeHtml(text + '\n');
        }
    }
    return {body, images};
}

function readCount(source: XiaoHeiHeLink, keys: string[]): number | null {
    for (const key of keys) {
        const value = (source as any)?.[key];
        if (value === undefined || value === null || value === '') continue;
        const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
}

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    // 步骤一：生成接口签名参数
    const now = Date.now();
    const apiPath = '/bbs/app/link/tree';
    const time = Math.floor(now / 1000);
    const nonce = createHash('md5')
        .update(`${time}${now}${Math.random()}${randomBytes(8).toString('hex')}`)
        .digest('hex')
        .toUpperCase();

    const params = new URLSearchParams({
        app: 'heybox',
        os_type: 'web',
        x_app: 'heybox_website',
        x_client_type: 'web',
        x_os_type: 'Windows',
        x_client_version: '',
        client_type: 'web',
        web_version: '3.0',
        version: '999.0.4',
        hkey: createHkey(apiPath, time + 1, nonce),
        _time: String(time),
        nonce: nonce,
        link_id: link.id,
        is_first: '1',
        page: '1',
        index: '1',
        limit: '20',
        owner_only: '0',
    });

    // 步骤二：请求帖子接口
    logger.debug(`正在请求小黑盒接口: ${link.id}`);
    let payload: XiaoHeiHeTreeResponse;
    try {
        const options: any = {
            method: 'GET',
            headers: {
                'User-Agent': config.userAgent,
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://www.xiaoheihe.cn/',
            },
        };
        if (config.proxy_settings[name] && config.proxy) options.proxyAgent = config.proxy;

        const response = await ctx.http(`https://api.xiaoheihe.cn${apiPath}?${params.toString()}`, options);
        payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    } catch (error: any) {
        logger.error(`请求小黑盒接口失败: ${error.message}`);
        return null;
    }

    if (payload?.status === 'show_captcha') {
        logger.error('小黑盒接口要求人机验证（出口 IP 风控触发），本次解析跳过。');
        return null;
    }
    if (payload?.status !== 'ok') {
        logger.error(`小黑盒接口返回异常: status=${payload?.status ?? 'none'} msg=${payload?.msg ?? ''}`);
        return null;
    }

    const post = payload.result?.link;
    if (!post) {
        logger.error('小黑盒接口未返回帖子内容。');
        return null;
    }
    logger.debug(`小黑盒帖子字段: ${Object.keys(post).join(',')}`);

    // 步骤三：构建结构化数据
    const {body, images} = parseRichText(post.text);
    const tags = (Array.isArray(post.content_tags) ? post.content_tags : []).map(readTagName).filter(Boolean);
    const videoUrl = typeof post.video_url === 'string' ? post.video_url : '';
    const coverUrl = post.video_thumb || post.thumb || images[0];

    let mainbody = body;
    const declaration = [post.post_declaration_v2?.content_source_desc, post.post_declaration_v2?.source_faq_desc]
        .filter(Boolean).join(' · ');
    if (declaration) mainbody += escapeHtml(`🔖 ${declaration}\n`);
    if (tags.length) mainbody += `标签：${tags.join(' | ')}\n`;

    const statsParts: string[] = [];
    statsParts.push(`收藏: ${numeral(readCount(post, ['favour_count']) ?? 0, config)}`);
    statsParts.push(`评论: ${numeral(readCount(post, ['comment_num']) ?? 0, config)}`);
    const award = readCount(post, ['link_award_num']);
    if (award) statsParts.push(`投蕉: ${numeral(award, config)}`);
    const forward = readCount(post, ['forward_num']);
    if (forward) statsParts.push(`转发: ${numeral(forward, config)}`);

    return {
        platform: name,
        title: typeof post.title === 'string' ? post.title : '',
        authorName: post.user?.username || post.user?.nickname || '',
        mainbody: mainbody,
        coverUrl: coverUrl,
        files: videoUrl ? [createXiaoHeiheVideoFile(link.id, videoUrl)] : [],
        sourceUrl: link.url,
        stats: statsParts.join(' | '),
    };
}
