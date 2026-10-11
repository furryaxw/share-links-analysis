// src/parsers/twitter.ts

import {Context, h, Session} from 'koishi';
import {FileInfo, Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, expandShortLink, numeral} from '../utils';

export const name = "twitter";

export function getFileCacheKey(url: string): string | null {
    try {
        const u = new URL(url);
        return `twitter:${u.pathname}`;
    } catch {
        return null;
    }
}

function createTwitterVideoFile(url: string): FileInfo {
    const cacheKey = getFileCacheKey(url);
    return cacheKey ? {type: 'video', url, cacheKey} : {type: 'video', url};
}

const linkRules = [
    {
        pattern: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|mobile\.twitter\.com)\/[a-zA-Z0-9_]+\/status\/(\d+)\b/gi,
        type: "tweet" as const,
    },
    {
        pattern: /https?:\/\/t\.co\/([a-zA-Z0-9]+)\b/gi,
        type: "short" as const,
    }
];

/**
 * 在文本中匹配 Twitter/X 链接
 */
export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();
    const initialLinks: Link[] = [];

    for (const rule of linkRules) {
        let m;
        rule.pattern.lastIndex = 0;
        while ((m = rule.pattern.exec(content)) !== null) {
            const id = m[2] || m[1];
            const url = rule.type === 'short' ? `https://t.co/${id}` : `https://x.com/i/status/${id}`;
            initialLinks.push({platform: name, type: rule.type, id, url});
        }
    }

    const logger = ctx.logger(`share-links-analysis:${name}`);
    const proxy = config.proxy_settings[name] ? config.proxy : undefined;

    for (const link of initialLinks) {
        let finalLink = link;

        if (link.type === 'short') {
            const finalUrl = await expandShortLink(ctx, link.url, config, logger, proxy);
            const match = /status\/(\d+)/.exec(finalUrl);
            if (match) {
                finalLink = {platform: name, type: 'tweet', id: match[1], url: `https://x.com/i/status/${match[1]}`};
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
 * 计算 Syndication API 所需的 Token
 * 算法来源: react-tweet / you-get (reverse engineered)
 */
function getToken(id: string): string {
    return ((Number(id) / 1e15) * Math.PI)
        .toString(36)
        .replace(/(0+|\.)/g, '');
}

/**
 * 展开文本中的 t.co 短链
 * 如果是推文附带的图片/视频链接，则移除；否则替换为展开的真实 URL
 */
async function processTweetText(ctx: Context, text: string, tweetId: string, data: any, config: PluginConfig): Promise<string> {
    let processedText = text || '';

    // 1. 如果 API 数据中包含 entities (如 Syndication API)，优先利用官方映射进行精准替换
    if (data?.entities) {
        // 移除媒体链接 (图片/视频等附件)
        if (Array.isArray(data.entities.media)) {
            data.entities.media.forEach((m: any) => {
                if (m.url) processedText = processedText.split(m.url).join('');
            });
        }
        // 展开普通外部/引用链接
        if (Array.isArray(data.entities.urls)) {
            data.entities.urls.forEach((u: any) => {
                if (u.url && u.expanded_url) {
                    processedText = processedText.split(u.url).join(u.expanded_url);
                }
            });
        }
    }

    // 2. 扫描并处理残留的 t.co 短链 (上一步没清理干净的情况)
    const tcoRegex = /https:\/\/t\.co\/\w+/g;
    const matches = processedText.match(tcoRegex);

    if (matches) {
        // 去重后进行请求
        const seenUrls = Array.from(new Set(matches));
        for (const tcoUrl of seenUrls) {
            let expandedUrl = tcoUrl;

            try {
                // 发送 HEAD 请求探测真实 URL，并应用代理设置
                const reqOptions: any = {redirect: 'follow'};
                if (config.proxy) reqOptions.proxyAgent = config.proxy;

                const res = await ctx.http('HEAD', tcoUrl, reqOptions);
                expandedUrl = res?.url || (res as any)?.request?.res?.responseUrl || tcoUrl;
            } catch (e: any) {
                // 即使报 403 等错误，只要重定向成功暴露了真实 url 就继续使用
                if (e.response && e.response.url) {
                    expandedUrl = e.response.url;
                } else {
                    ctx.logger(`share-links-analysis:${name}`).debug(`t.co 链接探测失败: ${tcoUrl} - ${e.message}`);
                }
            }

            if (expandedUrl && expandedUrl !== tcoUrl) {
                const isOwnMedia = new RegExp(`/status/${tweetId}/(photo|video)/`, 'i').test(expandedUrl) ||
                    expandedUrl.endsWith(`/status/${tweetId}`);

                if (isOwnMedia) {
                    processedText = processedText.split(tcoUrl).join('');
                } else {
                    processedText = processedText.split(tcoUrl).join(expandedUrl);
                }
            }
        }
    }

    return processedText.trim();
}

/**
 * 从推文数据对象中提取内容（文本、图片、视频、封面）
 * 适用于 Syndication API 数据结构
 */
function extractTweetContent(data: any, config: PluginConfig) {
    const images: string[] = [];
    const files: FileInfo[] = [];

    // 1. 图片 (Photos)
    if (data.photos && Array.isArray(data.photos)) {
        data.photos.forEach((p: any) => {
            images.push(p.url);
        });
    }

    // 2. 视频 (Video)
    // 优先从 mediaDetails 获取，因为它包含 bitrate 信息且结构更完整
    let videoVariants: any[] = [];
    let videoPoster = '';

    if (data.mediaDetails && Array.isArray(data.mediaDetails)) {
        for (const media of data.mediaDetails) {
            if (media.type === 'video' || media.type === 'animated_gif') {
                // 获取封面 (mediaDetails 中通常是 media_url_https)
                if (!videoPoster) videoPoster = media.media_url_https;

                // 获取变体
                if (media.video_info && media.video_info.variants) {
                    videoVariants.push(...media.video_info.variants);
                }
            }
        }
    }

    // 如果 mediaDetails 中没有找到视频，尝试回退到 data.video (简略版，通常无 bitrate)
    if (videoVariants.length === 0 && data.video && data.video.variants) {
        videoVariants = data.video.variants;
        if (!videoPoster) videoPoster = data.video.poster;
    }

    if (videoVariants.length > 0) {
        // 筛选 mp4 格式，兼容 content_type 和 type 字段
        const mp4Variants = videoVariants.filter((v: any) => {
            const type = v.content_type || v.type;
            return type === 'video/mp4';
        });

        let bestVariant = null;

        if (mp4Variants.length > 0) {
            // 排序逻辑
            if (config.Video_ClarityPriority === '2') {
                // 高清晰度优先: 按 bitrate 降序
                // 注意：如果使用 data.video 回退，bitrate 可能为 undefined，此时顺序可能不稳定
                bestVariant = mp4Variants.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            } else {
                // 低清晰度优先: 按 bitrate 升序
                bestVariant = mp4Variants.sort((a: any, b: any) => (a.bitrate || 0) - (b.bitrate || 0))[0];
            }
        }

        if (bestVariant) {
            // 兼容 url 和 src 字段
            const videoUrl = bestVariant.url || bestVariant.src;
            if (videoUrl) {
                files.push(createTwitterVideoFile(videoUrl));
                // 如果还没有封面（例如没有图片），使用视频封面
            }
        }
    }

    return {
        text: data.text || '',
        screenName: data.user?.screen_name || 'unknown',
        images,
        files,
        cover: videoPoster
    };
}

/**
 * 将 FxTwitter 的 raw_text.facets 转换为 entities 结构，供 processTweetText 复用：
 * media 段用于剔除附件链接，url 段用于替换为展开后的地址
 */
function facetsToEntities(tweet: any) {
    const entities: any = {};
    const facets = tweet?.raw_text?.facets;
    if (!Array.isArray(facets)) return entities;

    const media = facets
        .filter((f: any) => f?.type === 'media' && f.original)
        .map((f: any) => ({url: f.original}));
    const urls = facets
        .filter((f: any) => f?.type === 'url' && f.original && f.replacement)
        .map((f: any) => ({url: f.original, expanded_url: f.replacement}));

    if (media.length > 0) entities.media = media;
    if (urls.length > 0) entities.urls = urls;
    return entities;
}

/**
 * 从 FxTwitter API 数据对象中提取内容
 * 适用于 api.fxtwitter.com 的 tweet 结构
 */
function extractFxContent(tweet: any) {
    const images: string[] = [];
    const files: FileInfo[] = [];
    let videoPoster = '';

    const mediaList: any[] = Array.isArray(tweet?.media?.all) && tweet.media.all.length > 0
        ? tweet.media.all
        : [...(tweet?.media?.photos ?? []), ...(tweet?.media?.videos ?? [])];

    // 同一视频可能返回多种格式，优先取 mp4
    const videos = mediaList.filter((m: any) => ['video', 'gif', 'animated_gif'].includes(m?.type));
    const mp4Videos = videos.filter((m: any) => !m.format || m.format === 'mp4');
    const pickedVideos = mp4Videos.length > 0 ? mp4Videos : videos;

    for (const media of mediaList) {
        if (media?.type === 'photo' && media.url) images.push(media.url);
    }

    for (const media of pickedVideos) {
        const videoUrl = media.url || media.src;
        if (videoUrl && !files.some(f => f.url === videoUrl)) {
            files.push(createTwitterVideoFile(videoUrl));
        }
        if (!videoPoster) videoPoster = media.thumbnail_url || media.poster || media.thumbnail || '';
    }

    return {
        text: tweet?.raw_text?.text ?? tweet?.text ?? '',
        screenName: tweet?.author?.screen_name || 'unknown',
        authorName: tweet?.author?.name || 'Unknown',
        images,
        files,
        cover: videoPoster
    };
}

/**
 * 使用 Syndication API 进行回退解析
 */
async function handleSyndicationFallback(
    ctx: Context,
    config: PluginConfig,
    tweetId: string,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}:fallback`);
    const token = getToken(tweetId);
    const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${token}`;

    try {
        logger.debug(`请求 Syndication API: ${apiUrl}`);

        const reqOptions: any = {
            headers: {
                'User-Agent': config.userAgent,
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': 'https://platform.twitter.com/'
            }
        };
        if (config.proxy) reqOptions.proxyAgent = config.proxy;

        const data = await ctx.http.get(apiUrl, reqOptions);

        if (!data || !data.text) {
            throw new Error('Syndication API 返回数据无效或推文不存在');
        }


        const user = data.user;
        const authorName = user?.name || 'Unknown';
        const screenName = user?.screen_name || 'unknown';
        const statsString = `点赞: ${numeral(data.favorite_count, config)} | 评论: ${numeral(data.conversation_count, config)}`;

        const main = extractTweetContent(data, config);

        let mainbody = await processTweetText(ctx, main.text, tweetId, data, config);

        if (main.images.length > 0) {
            mainbody += '\n' + main.images.map(img => h.image(img).toString()).join('\n');
        }

        const files: FileInfo[] = [...main.files];
        const coverUrl = main.cover;

        // 解析引用推文
        const quoteData = data.quoted_tweet;
        if (quoteData) {
            const quoteId = quoteData.id_str || quoteData.tweet_id || "unknown";
            const quote = extractTweetContent(quoteData, config);
            const processedQuoteText = await processTweetText(ctx, quote.text, quoteId, quoteData, config);

            mainbody += `\n----------\n[引用 @${quote.screenName}]: ${escapeHtml(processedQuoteText)}`;
            if (quote.images.length > 0) {
                mainbody += '\n' + quote.images.map(img => h.image(img).toString()).join('\n');
            }
            files.push(...quote.files);
        }

        return {
            platform: name,
            title: `@${screenName} 的推文`,
            authorName,
            mainbody,
            sourceUrl: `https://x.com/${screenName}/status/${tweetId}`,
            stats: statsString,
            files,
            coverUrl,
            sensitive: !!data.possibly_sensitive
        };

    } catch (e: any) {
        const causeDetail = e.cause ? ` (cause: ${e.cause.code || e.cause.message || e.cause})` : '';
        logger.error(`Syndication fallback failed: ${e.message}${causeDetail}`);
        if (e.response?.status) logger.error(`  HTTP status: ${e.response.status}`);
        // 抛出错误让外部统一处理 404 等信息
        throw e;
    }
}

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    const tweetId = link.id;
    // 首选: FxTwitter API
    try {
        const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
        logger.debug(`请求 FxTwitter API: ${apiUrl}`);

        const reqOptions: any = {
            headers: {
                'User-Agent': config.userAgent
            }
        };
        if (config.proxy) reqOptions.proxyAgent = config.proxy;

        const payload = await ctx.http.get(apiUrl, reqOptions);

        if (!payload || payload.code !== 200 || !payload.tweet) {
            const apiError: any = new Error(`FxTwitter API 返回无效 (code: ${payload?.code ?? 'none'}, message: ${payload?.message ?? 'none'})`);
            apiError.apiCode = payload?.code;
            throw apiError;
        }

        const tweet = payload.tweet;
        const main = extractFxContent(tweet);
        const statsString = `点赞: ${numeral(tweet.likes, config)} | 评论: ${numeral(tweet.replies, config)} | 转发: ${numeral(tweet.retweets, config)}`;

        let processedMainText = await processTweetText(ctx, main.text, tweetId, {entities: facetsToEntities(tweet)}, config);
        let mainbody = escapeHtml(processedMainText);

        if (main.images.length > 0) {
            mainbody += '\n' + main.images.map(img => h.image(img).toString()).join('\n');
        }

        const files: FileInfo[] = [...main.files];
        const coverUrl = main.cover;

        // 解析引用推文
        const quoteData = tweet.quote;
        if (quoteData) {
            const quoteId = quoteData.id || "unknown";
            const quote = extractFxContent(quoteData);
            const processedQuoteText = await processTweetText(ctx, quote.text, quoteId, {entities: facetsToEntities(quoteData)}, config);

            mainbody += `\n----------\n[引用 @${quote.screenName}]: ${escapeHtml(processedQuoteText)}`;
            if (quote.images.length > 0) {
                mainbody += '\n' + quote.images.map(img => h.image(img).toString()).join('\n');
            }
            files.push(...quote.files);
        }

        return {
            platform: name,
            title: `@${main.screenName} 的推文`,
            authorName: main.authorName,
            mainbody,
            sourceUrl: `https://x.com/${main.screenName}/status/${tweetId}`,
            stats: statsString,
            files,
            coverUrl,
            sensitive: !!tweet.possibly_sensitive
        };

    } catch (error: any) {
        // 404 表示推文不存在（HTTP 层或 API 层），其余错误尝试 Fallback 到 Syndication
        const isNotFound = error.response?.status === 404 || error.apiCode === 404;

        if (!isNotFound) {
            const causeDetail = error.cause ? ` (cause: ${error.cause.code || error.cause.message || error.cause})` : '';
            logger.warn(`FxTwitter API 失败 (${error.message}${causeDetail})，尝试 Syndication API Fallback...`);
            try {
                return await handleSyndicationFallback(ctx, config, tweetId, session);
            } catch (fallbackError: any) {
                const fbCauseDetail = fallbackError.cause ? ` (cause: ${fallbackError.cause.code || fallbackError.cause.message || fallbackError.cause})` : '';
                logger.error(`Fallback 失败: ${fallbackError.message}${fbCauseDetail}`);
                logger.error(`Twitter 解析失败: 主 API 和 Fallback 均失败`);
            }
        } else {
            logger.error(`Twitter 解析失败: ${error.message}`);
        }

        // 最终错误处理
        if (isNotFound) {
            await session.send('推文不存在或已被删除');
        } else if (error.response?.status === 429) {
            await session.send('API 请求过频，请稍后');
        }
        return null;
    }
}
