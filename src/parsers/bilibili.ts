// src/parsers/bilibili.ts

import {Context, h, Session} from 'koishi';
import {BilibiliVideoInfo, FileInfo, Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, expandShortLink, getCookie, numeral} from '../utils';
import crypto from 'crypto';

export const name = "bilibili";

// --- AV/BV 转换常量与算法 ---
const TABLE = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
const MAX_AVID = 1n << 51n;
const BASE = 58n;
const BVID_LEN = 12n;
const XOR = 23442827791579n;

function avToBv(avid: string | number): string {
    let cleanAvid: string;
    if (typeof avid === 'string') {
        cleanAvid = avid.replace(/^av/i, '');
    } else {
        cleanAvid = avid.toString();
    }

    const avidBigInt = BigInt(cleanAvid);
    if (avidBigInt <= 0n || avidBigInt >= MAX_AVID) {
        return avid.toString();
    }

    const result = ['B', 'V', '1', '', '', '', '', '', '', '', '', ''];
    let idx = BVID_LEN - 1n;
    let temp = (MAX_AVID | avidBigInt) ^ XOR;

    while (temp !== 0n) {
        result[Number(idx)] = TABLE[Number(temp % BASE)];
        temp /= BASE;
        idx -= 1n;
    }

    [result[3], result[9]] = [result[9], result[3]];
    [result[4], result[7]] = [result[7], result[4]];

    return result.join('');
}

// --- WBI 签名算法与视频流获取 ---
const mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
    19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60,
    51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function getMixinKey(orig: string) {
    return mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
}

function md5(str: string) {
    return crypto.createHash('md5').update(str).digest('hex');
}

export function getFileCacheKey(url: string): string | null {
    try {
        const u = new URL(url);
        return `bilibili:${u.pathname}`;
    } catch {
        return null;
    }
}

function createBilibiliFile(url: string): FileInfo {
    const cacheKey = getFileCacheKey(url);
    return cacheKey ? {type: 'video', url, cacheKey} : {type: 'video', url};
}

async function getWbiKeys(ctx: Context, userAgent: string) {
    try {
        const res = await ctx.http.get('https://api.bilibili.com/x/web-interface/nav', {
            headers: {'User-Agent': userAgent, 'Referer': 'https://www.bilibili.com'}
        });
        const wbiImg = res.data?.wbi_img;
        if (!wbiImg) return null;
        const img_url = wbiImg.img_url;
        const sub_url = wbiImg.sub_url;
        return {
            img_key: img_url.slice(img_url.lastIndexOf('/') + 1, img_url.lastIndexOf('.')),
            sub_key: sub_url.slice(sub_url.lastIndexOf('/') + 1, sub_url.lastIndexOf('.'))
        };
    } catch (e) {
        return null;
    }
}

function encWbi(params: Record<string, string | number>, img_key: string, sub_key: string) {
    const mixin_key = getMixinKey(img_key + sub_key);
    const curr_time = Math.round(Date.now() / 1000);
    const chr_filter = /[!'()*]/g;

    const newParams: Record<string, string | number> = {...params, wts: curr_time};
    const query = Object.keys(newParams)
        .sort()
        .map(key => {
            const value = (newParams[key] || '').toString().replace(chr_filter, '');
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        })
        .join('&');

    const wbi_sign = md5(query + mixin_key);
    return `${query}&w_rid=${wbi_sign}`;
}

/**
 * 独立获取 Bilibili 视频流
 */
async function getVideoStream(ctx: Context, aid: number, bvid: string, cid: number, qn: number, config: PluginConfig) {
    const keys = await getWbiKeys(ctx, config.userAgent);
    if (!keys) throw new Error("无法获取 WBI Keys");

    const params = {
        avid: aid,
        bvid: bvid,
        cid: cid,
        qn: qn,
        high_quality: 1,
        fnver: 0,
        fnval: 1,
        fourk: 1,
        platform: 'html5'
    };

    const query = encWbi(params, keys.img_key, keys.sub_key);
    const url = `https://api.bilibili.com/x/player/wbi/playurl?${query}`;

    // 必须带有 Referer 和 User-Agent，否则很容易触发 412 风控拦截
    return await ctx.http.get(url, {
        headers: {
            'User-Agent': config.userAgent,
            'Referer': 'https://www.bilibili.com'
        }
    });
}

// --- 链接匹配规则 ---
const linkRules = [
    // Video: 匹配 BV/av 号
    {
        pattern: /(?:https?:\/\/)?(?:www\.|m\.)?bilibili\.com\/video\/([aA][vV]\d+|[bB][vV][1-9A-HJ-NP-Za-km-z]{10})\b/gi,
        type: "video" as const,
    },
    // Live: 直播
    {
        pattern: /(?:https?:\/\/)?live\.bilibili\.com(?:\/h5)?\/(\d+)\b/gi,
        type: "live" as const,
    },
    // Article: 专栏 (cv号)
    {
        pattern: /(?:https?:\/\/)?(?:www\.|m\.)?bilibili\.com\/read\/cv(\d+)\b/gi,
        type: "article" as const,
    },
    // Opus / Dynamic / t.bilibili: 动态与新版专栏
    // 覆盖: m.bilibili.com/dynamic/, www.bilibili.com/opus/, t.bilibili.com/
    {
        pattern: /(?:https?:\/\/)?(?:(?:www\.|m\.)bilibili\.com\/(?:opus|dynamic)\/|t\.bilibili\.com\/)(\d+)\b/gi,
        type: "opus" as const,
    },
    // Space: 个人空间 (支持 space.bilibili.com 和 bilibili.com/space)
    {
        pattern: /(?:https?:\/\/)?(?:space\.bilibili\.com|(?:www|m)\.bilibili\.com\/space)\/(\d+)\b/gi,
        type: "space" as const,
    },
    // Audio: 音乐 (au)
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/audio\/au(\d+)\b/gi,
        type: "audio" as const,
    },
    // AudioMenu: 歌单 (am)
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/audio\/am(\d+)\b/gi,
        type: "audio_menu" as const,
    },
    // Bangumi EP: 番剧单集
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/bangumi\/play\/ep(\d+)\b/gi,
        type: "bangumi_ep" as const,
    },
    // Bangumi SS: 番剧 Season
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/bangumi\/play\/ss(\d+)\b/gi,
        type: "bangumi_ss" as const,
    },
    // Bangumi MD: 媒体 ID
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/bangumi\/media\/md(\d+)\b/gi,
        type: "bangumi_md" as const,
    },
    // Short: 短链接 (b23.tv)
    {
        pattern: /(?:https?:\/\/)?b23\.tv\/([a-zA-Z0-9]+)\b/gi,
        type: "short" as const,
    },
];

// 匹配独立的 BV 号 regex
const bvPattern = /(?<![a-zA-Z0-9/])(BV[1-9A-HJ-NP-Za-km-z]{10})(?![a-zA-Z0-9])/gi;

/**
 * 在文本中匹配B站链接
 */
export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();

    // 内部帮助函数：运行正则提取
    function extractLinks(text: string): Link[] {
        const extracted: Link[] = [];
        for (const {pattern, type} of linkRules) {
            let m;
            pattern.lastIndex = 0;
            while ((m = pattern.exec(text)) !== null) {
                let id = m[1];
                if (!id) continue;
                if (type === 'video' && id.toLowerCase().startsWith('av')) {
                    try {
                        id = avToBv(id);
                    } catch (e) {
                    }
                }
                let url = m[0];
                if (type === 'video') url = `https://www.bilibili.com/video/${id}`;
                else if (type !== 'short' && !url.startsWith('http')) url = `https://${url}`;
                extracted.push({platform: name, type, id, url});
            }
        }
        let bvMatch;
        bvPattern.lastIndex = 0;
        while ((bvMatch = bvPattern.exec(text)) !== null) {
            extracted.push({
                platform: name,
                type: 'video',
                id: bvMatch[1],
                url: `https://www.bilibili.com/video/${bvMatch[1]}`
            });
        }
        return extracted;
    }

    const initialLinks = extractLinks(content);

    const logger = ctx.logger(`share-links-analysis:${name}`);
    const proxy = config.proxy_settings[name] ? config.proxy : undefined;

    for (const link of initialLinks) {
        let finalLink = link;

        if (link.type === 'short') {
            const finalUrl = await expandShortLink(ctx, link.url, config, logger, proxy);

            if (finalUrl && !finalUrl.includes('b23.tv')) {
                const resolvedLinks = extractLinks(finalUrl);
                if (resolvedLinks.length > 0) finalLink = resolvedLinks[0]; // 替换为视频/动态对象
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
 * 处理单个B站链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @param session
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    let currentLink = link;

    // --- 根据类型分发处理逻辑 ---

    // === Video (视频) ===
    if (currentLink.type === 'video') {
        return await processVideo(ctx, config, currentLink, logger);
    }
    // === Live (直播) ===
    else if (currentLink.type === 'live') {
        return await processLive(ctx, config, currentLink, logger);
    }
    // === Article (专栏) ===
    else if (currentLink.type === 'article') {
        return await processArticle(ctx, config, currentLink, logger);
    }
    // === Opus (动态) ===
    else if (currentLink.type === 'opus') {
        return await processOpus(ctx, config, currentLink, logger);
    }
    // === Space (空间) ===
    else if (currentLink.type === 'space') {
        return await processSpace(ctx, config, currentLink, logger);
    }
    // === Audio (音乐) ===
    else if (currentLink.type === 'audio') {
        return await processAudio(ctx, config, currentLink, logger);
    }
    // === AudioMenu (音乐目录) ===
    else if (currentLink.type === 'audio_menu') {
        return await processAudioMenu(ctx, config, currentLink, logger);
    }
    // === Bangumi (番剧) ===
    else if (currentLink.type.startsWith('bangumi_')) {
        return await processBangumi(ctx, config, currentLink, logger);
    }

    return null;
}

// --------------------------------------------------------------------------
// 子处理函数
// --------------------------------------------------------------------------

async function processVideo(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const videoId = link.id;
    const idType = videoId.startsWith('BV') ? 'bvid' : 'aid';
    const infoUrl = `https://api.bilibili.com/x/web-interface/view?${idType}=${videoId}`;

    try {
        const info = await ctx.http.get<BilibiliVideoInfo>(infoUrl, {
            headers: {'User-Agent': config.userAgent}
        });

        if (!info || !info.data) {
            logger.warn(`B站API未返回有效视频数据，ID: ${videoId}`);
            return null;
        }
        const data = info.data;

        // 获取视频流直链
        let videoUrl: string | null = null;
        try {
            // 定义画质梯队。如果开启高画质，依次尝试 80(1080p) -> 64(720p) -> 32(480p) -> 16(360p)
            const qnList = config.Video_ClarityPriority === '2' ? [80, 64, 32, 16] : [32, 16];
            const maxBytes = config.Max_size * 1024 * 1024;

            for (const qn of qnList) {
                // 调用原生接口
                const videoStream = await getVideoStream(ctx, data.aid, data.bvid, data.pages[0].cid, qn, config);
                const durl = videoStream?.data?.durl?.[0];

                if (durl && durl.url) {
                    // B站接口会返回精确的文件大小 size
                    if (durl.size && durl.size <= maxBytes) {
                        videoUrl = durl.url;
                        logger.debug(`成功匹配合适清晰度 qn=${qn}，体积: ${(durl.size / 1024 / 1024).toFixed(2)}MB`);
                        break; // 满足限制，跳出循环
                    } else if (qn === qnList[qnList.length - 1]) {
                        // 如果已经是能给的最低画质却依然超限，只能交出去，让 utils.ts 去拦截并输出“超限提示”
                        videoUrl = durl.url;
                        logger.debug(`B站视频即便降至最低画质 qn=${qn} 仍超限，交由底层拦截。`);
                    } else {
                        // 超限但还有降级空间
                        logger.debug(`当前画质 qn=${qn} 超限 (${(durl.size / 1024 / 1024).toFixed(2)}MB > ${config.Max_size}MB)，正在降级...`);
                    }
                } else {
                    break; // 接口异常，直接退出
                }
            }
        } catch (e: any) {
            logger.error(`获取视频流失败: ${e.message}`);
        }

        const statsString = `播放: ${numeral(data.stat.view, config)} | 弹幕: ${numeral(data.stat.danmaku, config)}\n` +
            `点赞: ${numeral(data.stat.like, config)} | 硬币: ${numeral(data.stat.coin, config)} | 收藏: ${numeral(data.stat.favorite, config)}`;

        const files: FileInfo[] = videoUrl ? [createBilibiliFile(videoUrl)] : [];

        return {
            platform: name,
            title: data.title,
            authorName: data.owner.name,
            mainbody: escapeHtml(data.desc),
            coverUrl: data.pic,
            files: files,
            sourceUrl: `https://www.bilibili.com/video/${data.bvid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`视频解析异常: ${e.message}`);
        return null;
    }
}

async function processLive(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const roomId = link.id;
    const apiUrl = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.live.bilibili.com'}
        });

        if (res.code !== 0 || !res.data) throw new Error(res.msg || 'API Error');
        const data = res.data;

        const statusMap: Record<number, string> = {0: '未开播', 1: '直播中', 2: '轮播中'};
        const statusText = statusMap[data.live_status] || '未知状态';

        const statsString = `状态: ${statusText} | 观看: ${numeral(data.online, config)} | 关注: ${numeral(data.attention, config)}`;

        // 构造 mainbody
        const mainbody = `${escapeHtml(data.description || '')}\n\n[${statusText}] ${data.area_name || ''}`;

        return {
            platform: name,
            title: data.title,
            authorName: `Live Room ${roomId}`, // API 中可能不直接包含用户名，需额外调用或忽略
            mainbody: mainbody,
            coverUrl: data.user_cover, // 或者 data.keyframe
            files: [],
            sourceUrl: `https://live.bilibili.com/${roomId}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`直播解析异常: ${e.message}`);
        return null;
    }
}

async function processArticle(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const cvId = link.id;
    const apiUrl = `https://api.bilibili.com/x/article/viewinfo?id=${cvId}`;

    try {
        // 获取 Cookie
        const cookie = await getCookie(ctx, config, name);

        const res = await ctx.http.get(apiUrl, {
            headers: {
                'User-Agent': config.userAgent,
                'Referer': `https://www.bilibili.com/read/cv${cvId}`,
                'Cookie': cookie || ''
            }
        });

        if (res.code !== 0 || !res.data) throw new Error(res.message || 'API Error');
        const data = res.data;

        const statsString = `阅读: ${numeral(data.stats.view, config)} | 点赞: ${numeral(data.stats.like, config)} | 硬币: ${numeral(data.stats.coin, config)}`;

        // 提取图片
        let mainbody = escapeHtml(data.summary || '');
        const coverImage = data.banner_url || data.image_urls?.[0] || data.origin_image_urls?.[0];
        if (coverImage) {
            // 添加第一张图作为正文配图
            mainbody += `\n` + h.image(coverImage).toString();
        }

        return {
            platform: name,
            title: data.title,
            authorName: data.author_name,
            mainbody: mainbody,
            coverUrl: coverImage,
            files: [],
            sourceUrl: `https://www.bilibili.com/read/cv${cvId}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`专栏解析异常: ${e.message}`);
        return null;
    }
}

async function processOpus(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const opusId = link.id;
    // B站新版动态必须传递 timezone_offset，否则部分动态获取为空或报错
    const apiUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?timezone_offset=-480&features=itemOpusStyle&id=${opusId}`;

    try {
        // 获取 Cookie
        const cookie = await getCookie(ctx, config, name);

        const res = await ctx.http.get(apiUrl, {
            headers: {
                'User-Agent': config.userAgent,
                'Referer': `https://t.bilibili.com/${opusId}`,
                'Cookie': cookie || ''
            }
        });

        if (res.code !== 0 || !res.data?.item) throw new Error(res.message || 'API Error');
        const item = res.data.item;
        const modules = item.modules;
        if (!modules) throw new Error('动态内容为空');

        const author = modules.module_author;
        const dynamic = modules.module_dynamic;
        const stat = modules.module_stat;

        // 辅助函数：提取分散的富文本节点
        const extractRichText = (nodes: any[]) => {
            if (!nodes || !Array.isArray(nodes)) return '';
            return nodes.map(n => n.orig_text || n.text || '').join('');
        };

        // 辅助函数：处理 B 站常用的无协议头链接 (比如 //www.bilibili.com/...)
        const formatJumpUrl = (url: string) => {
            if (!url) return '';
            if (url.startsWith('//')) return `https:${url}`;
            return url;
        };

        let title = `${author?.name || '未知用户'} 的动态`;
        let coverUrl = '';
        const images: string[] = [];

        // 1. 尝试从新版 API 提取文本
        let text = dynamic?.desc?.text
            || extractRichText(dynamic?.desc?.rich_text_nodes)
            || '';

        if (dynamic?.major) {
            const major = dynamic.major;

            if (major.type === 'MAJOR_TYPE_OPUS' && major.opus) {
                // 图文动态：提取文本，并将配图放进 images
                text = major.opus.summary?.text
                    || extractRichText(major.opus.summary?.rich_text_nodes)
                    || text;
                major.opus.pics?.forEach((p: any) => {
                    if (p.url) images.push(p.url);
                });
            } else if (major.type === 'MAJOR_TYPE_DRAW' && major.draw) {
                // 纯图动态：将配图放进 images
                major.draw.items?.forEach((i: any) => {
                    if (i.src) images.push(i.src);
                });
            } else if (major.type === 'MAJOR_TYPE_ARTICLE' && major.article) {
                // 专栏：提取标题和摘要，将封面放进 coverUrl
                title = major.article.title || title;
                text = major.article.desc || text;
                if (major.article.covers && major.article.covers.length > 0) {
                    coverUrl = major.article.covers[0];
                }
            } else if (major.type === 'MAJOR_TYPE_ARCHIVE' && major.archive) {
                // 视频：提取标题和摘要，将封面放进 coverUrl
                title = major.archive.title || title;
                text = major.archive.desc || text;
                if (major.archive.cover) {
                    coverUrl = major.archive.cover;
                }
            } else if (major.type === 'MAJOR_TYPE_COMMON' && major.common) {
                // 网页分享等：将封面放进 coverUrl
                title = major.common.title || title;
                text = major.common.desc || text;
                if (major.common.cover) {
                    coverUrl = major.common.cover;
                }
            }
        }

        // 2. VC 接口兜底：如果新接口彻底没有返回文字，调用老版 VC 接口补偿
        if (!text || text.trim() === '') {
            try {
                const vcApiUrl = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/get_dynamic_detail?dynamic_id=${opusId}`;
                const cookie = await getCookie(ctx, config, name);
                const vcRes = await ctx.http.get(vcApiUrl, {
                    headers: {'User-Agent': config.userAgent, 'Cookie': cookie || ''}
                });

                if (vcRes.code === 0 && vcRes.data?.card?.card) {
                    // 老版接口的 card 字段是一个 JSON 字符串，必须 parse
                    const cardData = JSON.parse(vcRes.data.card.card);
                    // 老版本中，文字一般存放在 item.description 或 item.content 里面
                    text = cardData.item?.description || cardData.item?.content || text;
                }
            } catch (vcErr) {
                logger.warn(`VC 接口补偿获取失败: ${vcErr}`);
            }
        }

        // 3. 处理转发嵌套逻辑，并严格控制排版
        let forwardBlock = ''; // 提前渲染好的转发区域代码

        if (item.type === 'DYNAMIC_TYPE_FORWARD' && item.orig) {
            const orig = item.orig;
            const origAuthor = orig.modules?.module_author?.name || '原作者';

            let origDesc = orig.modules?.module_dynamic?.desc?.text
                || extractRichText(orig.modules?.module_dynamic?.desc?.rich_text_nodes)
                || '';

            let origTitle = '';
            let origCover = '';
            let origImages: string[] = [];
            let origJumpUrl = '';

            if (orig.modules?.module_dynamic?.major) {
                const oMajor = orig.modules.module_dynamic.major;

                if (oMajor.type === 'MAJOR_TYPE_OPUS' && oMajor.opus) {
                    origDesc = oMajor.opus.summary?.text || origDesc;
                    oMajor.opus.pics?.forEach((p: any) => {
                        if (p.url) origImages.push(p.url);
                    });
                    origJumpUrl = oMajor.opus.jump_url;
                } else if (oMajor.type === 'MAJOR_TYPE_DRAW' && oMajor.draw) {
                    oMajor.draw.items?.forEach((i: any) => {
                        if (i.src) origImages.push(i.src);
                    });
                    origJumpUrl = oMajor.draw.jump_url;
                } else if (oMajor.type === 'MAJOR_TYPE_ARTICLE' && oMajor.article) {
                    origTitle = oMajor.article.title || '';
                    origDesc = oMajor.article.desc || origDesc;
                    if (oMajor.article.covers && oMajor.article.covers.length > 0) {
                        origCover = oMajor.article.covers[0];
                    }
                    origJumpUrl = oMajor.article.jump_url;
                } else if (oMajor.type === 'MAJOR_TYPE_ARCHIVE' && oMajor.archive) {
                    origTitle = oMajor.archive.title || '';
                    origDesc = oMajor.archive.desc || origDesc;
                    if (oMajor.archive.cover) {
                        origCover = oMajor.archive.cover;
                    }
                    origJumpUrl = oMajor.archive.jump_url || (oMajor.archive.bvid ? `https://www.bilibili.com/video/${oMajor.archive.bvid}` : '');
                } else if (oMajor.type === 'MAJOR_TYPE_COMMON' && oMajor.common) {
                    origTitle = oMajor.common.title || '';
                    origDesc = oMajor.common.desc || origDesc;
                    if (oMajor.common.cover) {
                        origCover = oMajor.common.cover;
                    }
                    origJumpUrl = oMajor.common.jump_url;
                }
            }

            // 按要求的顺序组装 forwardBlock
            // [转发自]
            forwardBlock += `\n\n${escapeHtml(`[转发自 @${origAuthor}]:`)}\n`;
            // [标题]
            if (origTitle) {
                forwardBlock += `${escapeHtml(`《${origTitle}》`)}\n`;
            }
            // [cover]
            if (origCover) {
                forwardBlock += h.image(origCover).toString() + '\n';
            }
            // [desc]
            if (origDesc) {
                forwardBlock += escapeHtml(origDesc.trim()) + '\n';
            }
            // [image]
            if (origImages.length > 0) {
                forwardBlock += origImages.map(url => h.image(url).toString()).join('') + '\n';
            }
            // [链接]
            if (origJumpUrl) {
                forwardBlock += escapeHtml(`${formatJumpUrl(origJumpUrl)}`);
            }
        }

        // 4. 清理首尾空格
        if (text) {
            text = text.trim();
        }

        // 5. 组合最终内容主体
        let mainbody = text ? escapeHtml(text) : '';

        // 5.1 追加最外层的自身配图
        if (images.length > 0) {
            mainbody += (mainbody ? '\n' : '') + images.map(url => h.image(url).toString()).join('');
        }

        // 5.2 将组装好的转发块（已包含转义和图文混排）追加到末尾
        if (forwardBlock) {
            mainbody += forwardBlock;
        }

        const statsString = `转发: ${numeral(stat?.forward?.count || 0, config)} | 评论: ${numeral(stat?.comment?.count || 0, config)} | 点赞: ${numeral(stat?.like?.count || 0, config)}`;

        return {
            platform: name,
            title: title,
            authorName: author?.name,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: [],
            sourceUrl: `https://www.bilibili.com/opus/${opusId}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`动态解析异常: ${e.message}`);
        return null;
    }
}

async function processSpace(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const mid = link.id;
    const apiUrl = `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;

    try {
        // 获取 Cookie
        const cookie = await getCookie(ctx, config, name);

        const res = await ctx.http.get(apiUrl, {
            headers: {
                'User-Agent': config.userAgent,
                'Referer': `https://space.bilibili.com/${mid}`,
                'Cookie': cookie || ''
            }
        });

        if (res.code !== 0 || !res.data) throw new Error(res.message || 'API Error');

        const card = res.data.card;
        const title = `${card.name} 的个人空间`;
        const coverUrl = card.face;

        // 构造空间描述
        const mainbody = `UID: ${card.mid}\n签名: ${card.sign || '无'}`;
        const statsString = `关注: ${numeral(card.attention, config)} | 粉丝: ${numeral(card.fans, config)}`;

        return {
            platform: name,
            title: title,
            authorName: card.name,
            mainbody: escapeHtml(mainbody),
            coverUrl: coverUrl,
            files: [],
            sourceUrl: `https://space.bilibili.com/${mid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`空间解析异常: ${e.message}`);
        return null;
    }
}

async function processAudio(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const sid = link.id;
    const apiUrl = `https://www.bilibili.com/audio/music-service-c/web/song/info?sid=${sid}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'www.bilibili.com'}
        });
        if (res.code !== 0 || !res.data) throw new Error(res.msg);
        const data = res.data;

        const statsString = `播放: ${numeral(data.statistic.play, config)} | 收藏: ${numeral(data.statistic.collect, config)} | 评论: ${numeral(data.statistic.comment, config)}`;

        return {
            platform: name,
            title: data.title,
            authorName: data.author,
            mainbody: escapeHtml(data.intro || ''),
            coverUrl: data.cover,
            // 如果需要音频文件，可在此处尝试提取（通常 B 站音频需要 sign 较难直接获取直链，此处暂不返回 files）
            files: [],
            sourceUrl: `https://www.bilibili.com/audio/au${sid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`音乐解析异常: ${e.message}`);
        return null;
    }
}

async function processAudioMenu(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const sid = link.id;
    const apiUrl = `https://www.bilibili.com/audio/music-service-c/web/menu/info?sid=${sid}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'www.bilibili.com'}
        });
        if (res.code !== 0 || !res.data) throw new Error(res.msg);
        const data = res.data;

        const statsString = `播放: ${numeral(data.statistic.play, config)} | 收藏: ${numeral(data.statistic.collect, config)} | 分享: ${numeral(data.statistic.share, config)}`;

        return {
            platform: name,
            title: data.title,
            authorName: data.uname, // 歌单创建者
            mainbody: escapeHtml(data.intro || ''),
            coverUrl: data.cover,
            files: [],
            sourceUrl: `https://www.bilibili.com/audio/am${sid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`歌单解析异常: ${e.message}`);
        return null;
    }
}

async function processBangumi(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    let seasonId = '', epId = '';

    if (link.type === 'bangumi_md') {
        try {
            const mdRes = await ctx.http.get(`https://api.bilibili.com/pgc/review/user?media_id=${link.id}`, {
                headers: {'User-Agent': config.userAgent}
            });
            if (mdRes.result?.media?.season_id) {
                seasonId = mdRes.result.media.season_id;
            } else {
                throw new Error('MDID lookup failed');
            }
        } catch (e) {
            logger.warn(`MDID转SeasonID失败: ${e}`);
            return null;
        }
    } else if (link.type === 'bangumi_ss') {
        seasonId = link.id;
    } else if (link.type === 'bangumi_ep') {
        epId = link.id;
    }

    const apiUrl = epId ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}` : `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.bilibili.com'}
        });

        if (res.code !== 0 || !res.result) throw new Error(res.message || 'API Error');
        const data = res.result;

        let title = data.season_title;
        let cover = data.cover;
        let desc = data.evaluate;

        // 如果是特定集数，尝试获取分集信息
        if (epId && data.episodes) {
            const ep = data.episodes.find((e: any) => e.ep_id == epId);
            if (ep) {
                title += ` - 第${ep.title}话 ${ep.long_title}`;
                cover = ep.cover; // 使用分集封面
            }
        }

        const stat = data.stat;
        const statsString = `评分: ${data.rating?.score || 'N/A'} | 播放: ${numeral(stat.views, config)} | 追番: ${numeral(stat.favorites, config)}`;

        return {
            platform: name,
            title: title,
            authorName: '哔哩哔哩番剧',
            mainbody: escapeHtml(desc),
            coverUrl: cover,
            files: [],
            sourceUrl: link.url,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`番剧解析异常: ${e.message}`);
        return null;
    }
}
