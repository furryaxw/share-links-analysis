// src/types.ts

// 定义解析出的链接基本信息
export interface Link {
    platform: string;
    type: string;
    id: string;
    url: string;
}

// 定义解析器处理后返回的统一结构化数据格式
export interface ParsedInfo {
    platform: string;
    title: string;
    authorName: string;
    mainbody?: string;
    coverUrl?: string;
    files: FileInfo[];
    sourceUrl: string;
    stats: string;
    _cache?: ParsedInfoCacheStatus;
    // 内容被平台标记为敏感：由会话层结合群组设置决定是否展示
    sensitive?: boolean;
}

export interface FileInfo {
    type: 'video' | 'audio' | 'generic'
    url: string;
    cacheKey?: string;
}

export interface ParsedInfoCacheStatus {
    parse?: string;
    file?: string;
}

// 插件配置接口
export interface PluginConfig {
    // 通用配置
    Video_ClarityPriority: '1' | '2';
    Max_size: number;
    Min_Interval: number;
    waitTip_Switch: false | string;
    useForward: 'plain' | 'forward' | 'mixed';
    usingLocal: boolean;
    sendFiles: boolean;
    sendVoice: boolean;
    sendVoiceOutside: boolean;
    sendLinks: boolean;

    // 缓存设置
    enableCache: boolean;
    cacheExpiration: number; // 缓存过期时间（小时）
    optimisticCache: boolean; // 是否开启乐观缓存
    optimisticExpiration: number; // 乐观缓存过期时间（小时）
    autoCleanInterval: number; // 自动清理间隔（小时）

    // 格式化配置
    format: string; // 主格式化模板

    // 高级设置
    parseLimit: number;
    useNumeral: boolean;
    showError: boolean;
    sensitiveMessage: string;
    blockedMessage: string;

    // CookieCloud 设置
    cookieCloud: {
        enable: boolean;
        host: string;
        uuid: string;
        password: string;
        interval: number;
    };

    // 代理设置
    proxy: string;
    proxy_settings: Record<string, boolean>;

    // 解析器设置
    default_parsers: Record<string, boolean>;
    allow_sensitive: boolean;

    youtube_ApiUrl: string;
    netease_apiUrl: string;

    // 跨环境路径映射设置
    onebotReadDir: string;
    localDownloadDir: string;

    // 调试设置
    userAgent: string;
    debug: boolean;

    // 遥测设置
    enableTelemetry: boolean;
    telemetryApiUrl: string;
}

// Bilibili API 返回的视频信息类型定义 (部分)
export interface BilibiliVideoInfo {
    data: {
        bvid: string;
        aid: number;
        videos: number;
        pic: string;
        title: string;
        pubdate: number;
        ctime: number;
        desc: string;
        duration: number;
        owner: {
            mid: number;
            name: string;
            face: string;
        };
        stat: {
            aid: number;
            view: number;
            danmaku: number;
            reply: number;
            favorite: number;
            coin: number;
            share: number;
            like: number;
        };
        pages: {
            cid: number;
            page: number;
            part: string;
            duration: number;
        }[];
    };
}

// 解决 ctx.puppeteer 的类型报错，以及新增的 DB 类型
declare module 'koishi' {
    interface Context {
        puppeteer?: any;
    }

    interface Tables {
        sla_parse_cache: SlaParseCache;
        sla_file_cache: SlaFileCache;
        sla_cookie_cache: SlaCookieCache;
        sla_parse_timeline: SlaParseTimelineNode;
        sla_group_settings: SlaGroupSettings;
    }
}

// 定义数据库表结构接口
export interface SlaParseCache {
    key: string;
    data: ParsedInfo;
    created_at: number; // 注意：虽然数据库可能是 double，ts类型用 number 即可
}

export interface SlaFileCache {
    hash: string;
    path: string;
    url: string;
    created_at: number;
}

export interface SlaCookieCache {
    platform: string;
    cookie: string;
    updated_at: number;
}

export interface SlaParseTimelineNode {
    node_id: string;
    cache_key: string;
    data: ParsedInfo;
    delta: string;
    created_at: number;
    last_checked_at: number;
}

export interface SlaGroupSettings {
    guildId: string;
    custom_parsers: Record<string, boolean>;
    nsfw_enabled: boolean;
}

// 为小红书笔记数据定义更详细的类型接口
export interface XhsImageInfo {
    imageScene: string;
    url: string;
}

export interface XhsImage {
    infoList: XhsImageInfo[];
    url_default: string;
}

export interface XhsNoteData {
    title: string;
    desc: string;
    type: 'video' | 'normal';
    time: number;
    lastUpdateTime: number;
    tagList: {
        name: string;
    }[];
    user: {
        nickname: string;
        avatar: string;
        userId: string;
    };
    interactInfo: {
        likedCount: string;
        collectedCount: string;
        commentCount: string;
        shareCount: string;
    };
    imageList?: XhsImage[];
    video?: {
        media: {
            duration: number;
            stream: {
                h264: { masterUrl: string }[];
            };
        };
    };
}

export interface XhsInitialState {
    note: {
        noteDetailMap: {
            [key: string]: {
                note: XhsNoteData;
            };
        };
    };
}

// 小黑盒帖子接口 (/bbs/app/link/tree) 的响应结构
export interface XiaoHeiHeUser {
    username?: string;
    nickname?: string;
    [key: string]: any;
}

export interface XiaoHeiHeTag {
    text?: string;
    [key: string]: any;
}

export interface XiaoHeiHeDeclaration {
    content_source_desc?: string;
    source_faq_desc?: string;
    [key: string]: any;
}

export interface XiaoHeiHeLink {
    title?: string;
    text?: string;
    user?: XiaoHeiHeUser;
    content_tags?: (XiaoHeiHeTag | string)[];
    video_url?: string;
    video_thumb?: string;
    thumb?: string;
    favour_count?: number | string;
    comment_num?: number | string;
    link_award_num?: number | string;
    forward_num?: number | string;
    post_declaration_v2?: XiaoHeiHeDeclaration;
    [key: string]: any;
}

export interface XiaoHeiHeTreeResponse {
    status?: string;
    msg?: string;
    result?: {
        link?: XiaoHeiHeLink;
        [key: string]: any;
    };
}
