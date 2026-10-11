// src/index.ts

import {Context, Schema, Session} from 'koishi';
import {init, parsers, parsers_str, processLink, resolveLinks} from './core';
import {ParsedInfo, PluginConfig, SlaFileCache, SlaParseCache, SlaParseTimelineNode} from './types';
import {buildTelemetryEndpoint, escapeHtml, getEffectiveSettings, getSettingsScope, isUserAdmin, sendResult, syncCookiesFromCloud} from './utils';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';

export const name = 'share-links-analysis';
export const inject = {
    required: ['database', 'puppeteer'],
    optional: [],
};

export const usage = `
开启插件后，即可自动解析分享链接。
向Bot发送B站、小红书等支持平台的分享链接，会返回图文信息与视频。
您可以在插件配置中为不同平台分别设置返回的图文消息格式。
此插件只测试过在Napcat下的兼容性情况，不保证其他平台可用。
`;

// 配置文件
export const Config: Schema<PluginConfig> = Schema.intersect([
    Schema.object({
        Video_ClarityPriority: Schema.union([
            Schema.const('1').description('低清晰度优先'),
            Schema.const('2').description('高清晰度优先'),
        ]).role('radio').default('1').description("发送的视频清晰度优先策略"),
        Max_size: Schema.number().default(20).description("允许发送的最大文件大小（Mb）"),
        Min_Interval: Schema.number().default(600).description("若干秒内不再处理相同链接，防止刷屏").min(1),
        waitTip_Switch: Schema.union([
            Schema.const(false).description('不返回文字提示'),
            Schema.string().description('返回文字提示'),
        ]).description("是否返回等待提示。开启后，会发送`等待提示语`").default(false),
        useForward: Schema.union([
            Schema.const("plain").description("普通发送"),
            Schema.const("forward").description("合并转发"),
            Schema.const("mixed").description("混合发送"),
        ]).default("forward").description("发送模式"),
        usingLocal: Schema.boolean().default(false).description("使用本地文件（关闭后代理设置无效）"),
        sendFiles: Schema.boolean().default(true).description("是否发送文件（视频等）"),
        sendVoice: Schema.boolean().default(true).description('是否发送额外的语音（音乐解析）'),
        sendVoiceOutside: Schema.boolean().default(true).description('是否将额外的语音单独发送（仅合并转发模式生效）'),
        sendLinks: Schema.boolean().default(false).description("是否附加直链（仅对合并发送有效）"),
    }).description("基础设置"),

    Schema.object({
        enableCache: Schema.boolean().default(true).description("开启缓存（包括解析结果缓存和资源文件缓存）"),
        cacheExpiration: Schema.number().default(5).description("L1 缓存过期时间（小时）。设为 0 则不过期。"),
        optimisticCache: Schema.boolean().default(true).description("开启乐观缓存"),
        optimisticExpiration: Schema.number().default(0).description("乐观缓存最大保留时间（小时）。设为 0 则不过期。"),
        autoCleanInterval: Schema.number().default(0).description("自动清理过期缓存的检查间隔（小时）。设为 0 则不检查缓存。"),
    }).description("缓存设置"),

    Schema.object({
        format: Schema.string().role('textarea').default(
            `{title}
{cover}
作者：{authorName}
{stats}
----------
{mainbody}
----------
{cache}
{sourceUrl}`
        ).description('图文/视频输出格式。<br/>可用占位符: `{title}`, `{cover}`, `{authorName}`, `{mainbody}`, `{stats}`, `{cache}`, `{sourceUrl}`'),
    }).description("格式化模板"),

    Schema.object({
        parseLimit: Schema.number().default(3).description("单对话多链接解析上限"),
        useNumeral: Schema.boolean().default(true).description("使用格式化数字 (如 10000 -> 1万)"),
        showError: Schema.boolean().default(false).description("当链接被阻止时提醒发送者"),
        sensitiveMessage: Schema.string().role('textarea').default(
            `内容包含敏感信息，已停止解析
如果你是管理员，你可以通过 help share 指令获取更多帮助`
        ).description("内容被判定为敏感且当前会话不允许时返回的提示文案。"),
        blockedMessage: Schema.string().role('textarea').default(
            `根据策略，该链接已被阻止解析：平台：{platform}
如果你是管理员，你可以通过 help share 指令获取更多帮助`
        ).description("链接被会话策略阻止时返回的提示文案。<br/>可用占位符: `{platform}`"),
    }).description("高级解析设置"),

    Schema.object({
        cookieCloud: Schema.object({
            enable: Schema.boolean().default(false).description('启用 CookieCloud 同步 (优先使用云端 Cookie)'),
            host: Schema.string().role('link').description('服务器地址'),
            uuid: Schema.string().role('secret').description('用户 UUID'),
            password: Schema.string().role('secret').description('端对端加密密码'),
        })
    }).description('CookieCloud 设置'),

    Schema.object({
        proxy: Schema.string().description("代理设置"),
        proxy_settings: Schema.object(
            Object.fromEntries(
                parsers_str.map(parser => [parser, Schema.boolean().default(false).description(`对${parser}使用代理`)])
            )
        ),
    }).description("代理设置"),

    Schema.object({
        default_parsers: Schema.object(
            Object.fromEntries(
                parsers_str.map(parser => [parser, Schema.boolean().default(true).description(`启用${parser}解析器`)])
            )
        ),
        allow_sensitive: Schema.boolean().default(false).description("允许NSFW内容"),
    }).description("默认解析器设置"),

    Schema.object({
        youtube_ApiUrl: Schema.string().role('link').description(
            '外挂 Python 解析服务的 API 地址，需要专用解析服务<br>' +
            '<a href="https://github.com/furryaxw/share-links-analysis/blob/Master/README.md" target="_blank">点击此处查看部署方式</a>'
        ).default('http://127.0.0.1:12001'),
    }).description('YouTube 解析设置'),

    Schema.object({
        netease_apiUrl: Schema.string().role('link').description(
            '网易云音乐 API (NeteaseCloudMusicApi) 的地址<br>' +
            '<a href="https://docs-neteasecloudmusicapi.focalors.ltd/#/?id=neteasecloudmusicapienhanced" target="_blank">点击此处查看部署方式</a>'
        ).default('http://127.0.0.1:3000'),
    }).description('网易云音乐设置'),

    Schema.object({
        onebotReadDir: Schema.string().description('OneBot 实现 (如 NapCat) 所在的容器或环境提供的路径前缀。').default("/app/.config/QQ/NapCat/temp"),
        localDownloadDir: Schema.string().description('与上述路径对应的、Koishi 所在的容器或主机可以访问的路径前缀。').default("/koishi/data/temp"),
    }).description('跨环境路径映射设置'),

    Schema.object({
        userAgent: Schema.string().description("所有 API 请求所用的 User-Agent").default("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
        debug: Schema.boolean().default(false).description("开启调试模式 (输出详细日志)"),
    }).description("调试设置"),

    Schema.object({
        enableTelemetry: Schema.boolean().default(false).description("启用遥测数据上报"),
        telemetryApiUrl: Schema.string().default("http://127.0.0.1:8080").description("遥测服务基础地址"),
    }).description("性能监控"),
]) as any;

async function reportMetric(ctx: Context, config: PluginConfig, payload: Record<string, any>) {
    if (!config.enableTelemetry || !config.telemetryApiUrl) return;

    const data = {
        app: "share_links_analysis", // 必填 app 标识
        timestamp: Date.now(),
        ...payload
    };

    // 异步发送，不阻塞主流程
    const targetUrl = buildTelemetryEndpoint(config.telemetryApiUrl, '/api/push');
    ctx.http.post(targetUrl, data).catch(e => {
        // 仅在调试模式下打印上报错误，避免刷屏
        if (config.debug) {
            ctx.logger('share-links-analysis').warn(`性能数据上报失败: ${e.message}`);
        }
    });
}

function getCombinedRetentionHours(config: PluginConfig): number {
    const expirations = [config.cacheExpiration, config.optimisticExpiration];
    if (expirations.some(value => value === 0)) return 0;
    return Math.max(...expirations);
}

function getRetentionThreshold(hours: number): number | null {
    if (hours === 0) return null;
    return Date.now() - hours * 60 * 60 * 1000;
}

function normalizeForCompare(value: any, keyName = ''): any {
    if (Array.isArray(value)) return value.map(item => normalizeForCompare(item));
    if (value && typeof value === 'object') {
        const output: Record<string, any> = {};
        for (const key of Object.keys(value).sort()) {
            if (key.startsWith('_')) continue;
            if (key === 'stats' || key === 'status') continue;
            if (key === 'url' && typeof value.cacheKey === 'string') continue;
            output[key] = normalizeForCompare(value[key], key);
        }
        return output;
    }
    return value;
}

function stableStringify(value: any): string {
    return JSON.stringify(normalizeForCompare(value));
}

function isSameParsedInfo(a: ParsedInfo, b: ParsedInfo): boolean {
    return stableStringify(a) === stableStringify(b);
}

function formatDiffValue(value: any): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value;
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function collectDiffLines(before: any, after: any, path = ''): string[] {
    if (stableStringify(before) === stableStringify(after)) return [];
    if (Array.isArray(before) || Array.isArray(after)) {
        return [
            `- ${path || 'root'}: ${formatDiffValue(before)}`,
            `+ ${path || 'root'}: ${formatDiffValue(after)}`
        ];
    }
    if (
        before && after &&
        typeof before === 'object' &&
        typeof after === 'object'
    ) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        const lines: string[] = [];
        for (const key of [...keys].sort()) {
            if (key.startsWith('_')) continue;
            const nextPath = path ? `${path}.${key}` : key;
            lines.push(...collectDiffLines(before[key], after[key], nextPath));
        }
        return lines;
    }
    return [
        `- ${path || 'root'}: ${formatDiffValue(before)}`,
        `+ ${path || 'root'}: ${formatDiffValue(after)}`
    ];
}

function buildParsedInfoDelta(previous: ParsedInfo | null, current: ParsedInfo): string {
    if (!previous) return 'base';
    const lines = collectDiffLines(normalizeForCompare(previous), normalizeForCompare(current));
    return lines.length > 0 ? lines.join('\n') : 'no changes';
}

function summarizeParsedInfo(data: ParsedInfo): string {
    const parts = [
        `标题: ${data.title || '无标题'}`,
        `作者: ${data.authorName || '未知'}`,
        `文件: ${Array.isArray(data.files) ? data.files.length : 0}`,
    ];
    if (data.stats) parts.push(`统计: ${data.stats}`);
    return parts.join('\n');
}

function summarizeDelta(delta: string): string {
    const lines = delta.split('\n');
    const text = lines.length > 8
        ? `${lines.slice(0, 8).join('\n')}\n...`
        : delta;
    return text.length > 800 ? `${text.slice(0, 797)}...` : text;
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {hour12: false});
}

function md5Hex(value: string): string {
    return createHash('md5').update(value).digest('hex');
}

function splitPlatformCacheKey(cacheKey: string): { platform: string, id: string } | null {
    const index = cacheKey.indexOf(':');
    if (index <= 0 || index >= cacheKey.length - 1) return null;
    return {
        platform: cacheKey.slice(0, index),
        id: cacheKey.slice(index + 1)
    };
}

function getParserFileCacheKey(platform: string, url: string, linkId?: string): string | null {
    const parser = parsers.find(item => item.name === platform) as {
        getFileCacheKey?: (url: string, linkId?: string) => string | null
    } | undefined;
    return parser?.getFileCacheKey?.(url, linkId) || null;
}

interface FileCacheRemap {
    oldHash: string;
    newHash: string;
    url: string;
    cacheKey: string;
}

interface TimelineFormatMigrationResult {
    totalNodes: number;
    keptNodes: number;
    rewrittenNodes: number;
    deltaUpdatedNodes: number;
    deduplicatedNodes: number;
    invalidCacheKeys: number;
    fileCacheRemaps: FileCacheRemap[];
}

interface FileCacheFormatMigrationResult {
    totalRows: number;
    finalRows: number;
    migratedRows: number;
    mergedRows: number;
    skippedRows: number;
    missingRows: number;
    conflictRows: number;
}

function isSameTimelineNodeRecord(a: SlaParseTimelineNode | undefined, b: SlaParseTimelineNode): boolean {
    if (!a) return false;
    return a.node_id === b.node_id
        && a.cache_key === b.cache_key
        && a.delta === b.delta
        && a.created_at === b.created_at
        && a.last_checked_at === b.last_checked_at
        && JSON.stringify(a.data) === JSON.stringify(b.data);
}

function isSameFileCacheRecord(a: SlaFileCache | undefined, b: SlaFileCache): boolean {
    if (!a) return false;
    return a.hash === b.hash
        && a.path === b.path
        && a.url === b.url
        && a.created_at === b.created_at;
}

function choosePreferredFileCacheRow(a: SlaFileCache, b: SlaFileCache): SlaFileCache {
    const aExists = Boolean(a.path) && fs.existsSync(a.path);
    const bExists = Boolean(b.path) && fs.existsSync(b.path);
    if (aExists !== bExists) return aExists ? a : b;
    return (a.created_at || 0) >= (b.created_at || 0) ? a : b;
}

function rewriteParsedInfoToCurrentCacheFormat(
    node: SlaParseTimelineNode
): {
    data: ParsedInfo,
    changed: boolean,
    invalidCacheKey: boolean,
    fileCacheRemaps: FileCacheRemap[],
} {
    const parts = splitPlatformCacheKey(node.cache_key);
    const files = Array.isArray(node.data?.files) ? node.data.files : [];
    if (files.length === 0) {
        return {
            data: node.data,
            changed: false,
            invalidCacheKey: !parts,
            fileCacheRemaps: [],
        };
    }

    let changed = false;
    const remaps: FileCacheRemap[] = [];
    const nextFiles = files.map(file => {
        if (!file?.url || !parts) return file;

        const nextCacheKey = getParserFileCacheKey(parts.platform, file.url, parts.id);
        if (nextCacheKey) {
            const oldHash = md5Hex(file.url);
            const newHash = md5Hex(nextCacheKey);
            if (oldHash !== newHash) {
                remaps.push({
                    oldHash,
                    newHash,
                    url: file.url,
                    cacheKey: nextCacheKey,
                });
            }

            if (file.cacheKey === nextCacheKey) return file;
            changed = true;
            return {...file, cacheKey: nextCacheKey};
        }

        if (typeof file.cacheKey === 'string') {
            changed = true;
            const {cacheKey, ...rest} = file;
            return rest;
        }

        return file;
    });

    return {
        data: changed ? {...node.data, files: nextFiles} : node.data,
        changed,
        invalidCacheKey: !parts,
        fileCacheRemaps: remaps,
    };
}

async function upsertTimelineNodesInBatches(ctx: Context, nodes: SlaParseTimelineNode[], batchSize = 200) {
    for (let index = 0; index < nodes.length; index += batchSize) {
        await ctx.database.upsert('sla_parse_timeline', nodes.slice(index, index + batchSize));
    }
}

async function removeTimelineNodesById(ctx: Context, nodeIds: string[]) {
    for (const nodeId of nodeIds) {
        await ctx.database.remove('sla_parse_timeline', {node_id: nodeId});
    }
}

async function upsertFileCacheRowsInBatches(ctx: Context, rows: SlaFileCache[], batchSize = 200) {
    for (let index = 0; index < rows.length; index += batchSize) {
        await ctx.database.upsert('sla_file_cache', rows.slice(index, index + batchSize));
    }
}

async function removeFileCacheHashes(ctx: Context, hashes: string[]) {
    for (const hash of hashes) {
        await ctx.database.remove('sla_file_cache', {hash});
    }
}

async function migrateTimelineCacheFormat(ctx: Context): Promise<TimelineFormatMigrationResult> {
    const allNodes = await ctx.database.get('sla_parse_timeline', {}) as SlaParseTimelineNode[];
    const groupedNodes = new Map<string, SlaParseTimelineNode[]>();
    const originalById = new Map<string, SlaParseTimelineNode>();
    const remapsByPair = new Map<string, FileCacheRemap>();

    for (const node of allNodes) {
        originalById.set(node.node_id, node);
        const group = groupedNodes.get(node.cache_key) || [];
        group.push(node);
        groupedNodes.set(node.cache_key, group);
    }

    const nodesToUpsert: SlaParseTimelineNode[] = [];
    const nodeIdsToRemove: string[] = [];
    let rewrittenNodes = 0;
    let deltaUpdatedNodes = 0;
    let deduplicatedNodes = 0;
    let invalidCacheKeys = 0;
    let keptNodes = 0;

    for (const nodes of groupedNodes.values()) {
        const sortedNodes = [...nodes].sort((a, b) => {
            if (a.created_at !== b.created_at) return a.created_at - b.created_at;
            return a.node_id.localeCompare(b.node_id);
        });

        const keptGroup: SlaParseTimelineNode[] = [];
        const keptByResult = new Map<string, SlaParseTimelineNode>();
        for (const node of sortedNodes) {
            const rewritten = rewriteParsedInfoToCurrentCacheFormat(node);
            if (rewritten.invalidCacheKey) invalidCacheKeys++;
            if (rewritten.changed) rewrittenNodes++;
            for (const remap of rewritten.fileCacheRemaps) {
                remapsByPair.set(`${remap.oldHash}->${remap.newHash}`, remap);
            }

            const candidate: SlaParseTimelineNode = rewritten.changed ? {...node, data: rewritten.data} : {...node};
            const resultKey = stableStringify(candidate.data);
            const sameKeptNode = keptByResult.get(resultKey);
            if (sameKeptNode) {
                sameKeptNode.last_checked_at = Math.max(
                    sameKeptNode.last_checked_at || sameKeptNode.created_at,
                    candidate.last_checked_at || candidate.created_at,
                    candidate.created_at,
                );
                nodeIdsToRemove.push(candidate.node_id);
                deduplicatedNodes++;
                continue;
            }

            keptGroup.push(candidate);
            keptByResult.set(resultKey, candidate);
        }

        for (let index = 0; index < keptGroup.length; index++) {
            const previous = index === 0 ? null : keptGroup[index - 1].data;
            const expectedDelta = previous ? buildParsedInfoDelta(previous, keptGroup[index].data) : 'base';
            if (keptGroup[index].delta !== expectedDelta) {
                keptGroup[index] = {...keptGroup[index], delta: expectedDelta};
                deltaUpdatedNodes++;
            }
        }

        keptNodes += keptGroup.length;
        for (const node of keptGroup) {
            if (!isSameTimelineNodeRecord(originalById.get(node.node_id), node)) {
                nodesToUpsert.push(node);
            }
        }
    }

    await upsertTimelineNodesInBatches(ctx, nodesToUpsert);
    await removeTimelineNodesById(ctx, nodeIdsToRemove);

    return {
        totalNodes: allNodes.length,
        keptNodes,
        rewrittenNodes,
        deltaUpdatedNodes,
        deduplicatedNodes,
        invalidCacheKeys,
        fileCacheRemaps: [...remapsByPair.values()],
    };
}

async function migrateFileCacheFormat(ctx: Context, remaps: FileCacheRemap[]): Promise<FileCacheFormatMigrationResult> {
    const allRows = await ctx.database.get('sla_file_cache', {}) as SlaFileCache[];
    const originalRows = new Map<string, SlaFileCache>();
    const finalRows = new Map<string, SlaFileCache>();

    for (const row of allRows) {
        originalRows.set(row.hash, row);
        finalRows.set(row.hash, {...row});
    }

    let migratedRows = 0;
    let mergedRows = 0;
    let skippedRows = 0;
    let missingRows = 0;
    let conflictRows = 0;

    for (const remap of remaps) {
        if (remap.oldHash === remap.newHash) {
            skippedRows++;
            continue;
        }

        const sourceRow = finalRows.get(remap.oldHash);
        const targetRow = finalRows.get(remap.newHash);

        if (!sourceRow) {
            if (targetRow) {
                skippedRows++;
            } else {
                missingRows++;
            }
            continue;
        }

        if (!targetRow) {
            finalRows.delete(remap.oldHash);
            finalRows.set(remap.newHash, {
                ...sourceRow,
                hash: remap.newHash,
                url: sourceRow.url || remap.url,
            });
            migratedRows++;
            continue;
        }

        if (sourceRow.path && targetRow.path && sourceRow.path !== targetRow.path) {
            conflictRows++;
        }

        const preferredRow = choosePreferredFileCacheRow(targetRow, sourceRow);
        finalRows.set(remap.newHash, {
            hash: remap.newHash,
            path: preferredRow.path,
            url: preferredRow.url || remap.url,
            created_at: Math.max(targetRow.created_at || 0, sourceRow.created_at || 0),
        });
        finalRows.delete(remap.oldHash);
        mergedRows++;
    }

    const rowsToUpsert: SlaFileCache[] = [];
    const hashesToRemove: string[] = [];

    for (const row of finalRows.values()) {
        if (!isSameFileCacheRecord(originalRows.get(row.hash), row)) {
            rowsToUpsert.push(row);
        }
    }

    for (const hash of originalRows.keys()) {
        if (!finalRows.has(hash)) hashesToRemove.push(hash);
    }

    await upsertFileCacheRowsInBatches(ctx, rowsToUpsert);
    await removeFileCacheHashes(ctx, hashesToRemove);

    return {
        totalRows: allRows.length,
        finalRows: finalRows.size,
        migratedRows,
        mergedRows,
        skippedRows,
        missingRows,
        conflictRows,
    };
}

function createTimelineNodeId(cacheKey: string, createdAt = Date.now()): string {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${safeKey}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`;
}

async function getTimelineNodes(ctx: Context, cacheKey: string): Promise<SlaParseTimelineNode[]> {
    const nodes = await ctx.database.get('sla_parse_timeline', {cache_key: cacheKey});
    return nodes.sort((a, b) => a.created_at - b.created_at);
}

function isTimelineNodeActive(config: PluginConfig, node: SlaParseTimelineNode): boolean {
    const threshold = getRetentionThreshold(getCombinedRetentionHours(config));
    if (threshold === null) return true;
    return (node.last_checked_at || node.created_at) >= threshold;
}

async function getActiveTimelineNodes(ctx: Context, config: PluginConfig, cacheKey: string): Promise<SlaParseTimelineNode[]> {
    const nodes = await getTimelineNodes(ctx, cacheKey);
    return nodes.filter(node => isTimelineNodeActive(config, node));
}

async function touchTimelineNode(
    ctx: Context,
    node: SlaParseTimelineNode,
    checkedAt = Date.now(),
    data?: ParsedInfo
): Promise<SlaParseTimelineNode> {
    const touched = {...node, data: data ?? node.data, last_checked_at: checkedAt};
    await ctx.database.upsert('sla_parse_timeline', [touched]);
    return touched;
}

async function createTimelineNodeFromCache(
    ctx: Context,
    cacheKey: string,
    result: ParsedInfo,
    createdAt: number,
    delta = 'base'
): Promise<SlaParseTimelineNode> {
    const node: SlaParseTimelineNode = {
        node_id: createTimelineNodeId(cacheKey, createdAt),
        cache_key: cacheKey,
        data: result,
        delta,
        created_at: createdAt,
        last_checked_at: createdAt,
    };
    await ctx.database.upsert('sla_parse_timeline', [node]);
    return node;
}

async function upsertTimelineIfChanged(
    ctx: Context,
    config: PluginConfig,
    cacheKey: string,
    result: ParsedInfo
): Promise<SlaParseTimelineNode> {
    const nodes = await getActiveTimelineNodes(ctx, config, cacheKey);
    const latest = nodes[nodes.length - 1];
    if (latest && isSameParsedInfo(latest.data, result)) {
        return touchTimelineNode(ctx, latest, Date.now(), result);
    }

    const now = Date.now();
    const node: SlaParseTimelineNode = {
        node_id: createTimelineNodeId(cacheKey, now),
        cache_key: cacheKey,
        data: result,
        delta: buildParsedInfoDelta(latest?.data ?? null, result),
        created_at: now,
        last_checked_at: now,
    };
    await ctx.database.upsert('sla_parse_timeline', [node]);
    return node;
}

async function removeExpiredTimelineNodes(ctx: Context, threshold: number | null) {
    if (threshold === null) return;
    await ctx.database.remove('sla_parse_timeline', {
        last_checked_at: {$lt: threshold}
    });
}

async function pruneExpiredTimelineNodes(ctx: Context, config: PluginConfig): Promise<void> {
    await removeExpiredTimelineNodes(ctx, getRetentionThreshold(getCombinedRetentionHours(config)));
}

async function getLatestTimelineNode(
    ctx: Context,
    config: PluginConfig,
    cacheKey: string
): Promise<SlaParseTimelineNode | null> {
    const nodes = await getActiveTimelineNodes(ctx, config, cacheKey);
    return nodes[nodes.length - 1] || null;
}

function registerLegacyParseCacheModel(ctx: Context) {
    ctx.model.extend('sla_parse_cache', {
        key: 'string',
        data: 'json',
        created_at: 'double',
    }, {primary: 'key'});
}

async function getLegacyParseCacheEntries(ctx: Context): Promise<SlaParseCache[]> {
    try {
        registerLegacyParseCacheModel(ctx);
        return await ctx.database.get('sla_parse_cache', {}) as SlaParseCache[];
    } catch {
        return [];
    }
}

async function migrateLegacyParseCache(ctx: Context): Promise<{
    legacyParse: number,
    migrated: number,
    skipped: number,
    invalid: number,
    mismatched: number
}> {
    const legacyEntries = await getLegacyParseCacheEntries(ctx);
    let migrated = 0;
    let skipped = 0;
    let invalid = 0;

    for (const entry of legacyEntries) {
        if (!entry?.key || !entry.data || !entry.created_at) {
            invalid++;
            continue;
        }

        const nodes = await getTimelineNodes(ctx, entry.key);
        const sameNode = nodes.find(node => isSameParsedInfo(node.data, entry.data));
        if (sameNode) {
            await touchTimelineNode(ctx, sameNode, Math.max(sameNode.last_checked_at || 0, entry.created_at));
            skipped++;
            continue;
        }

        const latest = nodes[nodes.length - 1];
        const delta = latest ? buildParsedInfoDelta(latest.data, entry.data) : 'base';
        await createTimelineNodeFromCache(ctx, entry.key, entry.data, entry.created_at, delta);
        migrated++;
    }

    let mismatched = 0;
    for (const entry of legacyEntries) {
        if (!entry?.key || !entry.data) continue;
        const nodes = await getTimelineNodes(ctx, entry.key);
        if (!nodes.some(node => isSameParsedInfo(node.data, entry.data))) {
            mismatched++;
        }
    }

    return {
        legacyParse: legacyEntries.length,
        migrated,
        skipped,
        invalid,
        mismatched,
    };
}

async function dropLegacyParseCache(ctx: Context): Promise<string> {
    const messages: string[] = [];
    try {
        registerLegacyParseCacheModel(ctx);
        await ctx.database.remove('sla_parse_cache', {});
        messages.push('旧 sla_parse_cache 数据已清空。');
    } catch (e: any) {
        messages.push(`清空旧 sla_parse_cache 失败: ${e.message || String(e)}`);
    }

    const database = ctx.database as any;
    const candidates = [
        {fn: database.drop, args: ['sla_parse_cache']},
        {fn: database.dropTable, args: ['sla_parse_cache']},
        {fn: database.dropTables, args: [['sla_parse_cache']]},
    ];
    let dropped = false;
    for (const candidate of candidates) {
        if (typeof candidate.fn !== 'function') continue;
        try {
            const result = candidate.fn.apply(database, candidate.args);
            if (result && typeof result.then === 'function') await result;
            messages.push('旧表 sla_parse_cache 已尝试删除。');
            dropped = true;
            break;
        } catch {
        }
    }
    if (!dropped) {
        messages.push('当前数据库适配器未暴露删除 sla_parse_cache 的表 API，请按需手动 drop。');
    }

    return messages.join('\n');
}

export function apply(ctx: Context, config: PluginConfig) {
    // 数据库模型定义
    ctx.model.extend('sla_cookie_cache', {
        platform: 'string', // 平台名称，如 'xiaohongshu'
        cookie: 'text',   // 存储的 cookie 字符串
    }, {
        primary: 'platform' // 使用平台名称作为主键
    });

    ctx.model.extend('sla_group_settings', {
        guildId: 'string',
        custom_parsers: 'json',
        nsfw_enabled: 'boolean',
    }, {
        primary: 'guildId',
    });

    // 资源文件缓存 (hash)
    ctx.model.extend('sla_file_cache', {
        hash: 'string', // URL MD5
        path: 'string', // 本地绝对路径
        url: 'string',
        created_at: 'double',
    }, {primary: 'hash'});

    // 解析结果时间线
    ctx.model.extend('sla_parse_timeline', {
        node_id: 'string',
        cache_key: 'string',
        data: 'json',
        delta: 'text',
        created_at: 'double',
        last_checked_at: 'double',
    }, {primary: 'node_id'});

    const logger = ctx.logger('share-links-analysis');
    // 根据配置设置日志等级
    if (config.debug) {
        logger.level = 3; // Debug Level
    }

    const pendingChecks = new Map<string, Promise<ParsedInfo | null>>();

    // 清理缓存函数
    const cleanExpiredCache = async () => {
        if (!config.enableCache) return;
        const fileAndTimelineThreshold = getRetentionThreshold(getCombinedRetentionHours(config));

        // 清理文件缓存
        const expiredFiles = fileAndTimelineThreshold === null
            ? []
            : await ctx.database.get('sla_file_cache', {
                created_at: {$lt: fileAndTimelineThreshold}
            });

        for (const file of expiredFiles) {
            try {
                if (fs.existsSync(file.path)) {
                    await fs.promises.unlink(file.path);
                }
            } catch (e) {
                logger.warn(`删除过期文件失败 ${file.path}: ${e}`);
            }
        }

        if (fileAndTimelineThreshold !== null) {
            await ctx.database.remove('sla_file_cache', {
                created_at: {$lt: fileAndTimelineThreshold}
            });
            await pruneExpiredTimelineNodes(ctx, config);
        }

        if (expiredFiles.length > 0) {
            logger.info(`已自动清理 ${expiredFiles.length} 个过期文件。`);
        }
    };

    // 设置定时清理
    if (config.enableCache && config.autoCleanInterval > 0) {
        ctx.setInterval(cleanExpiredCache, config.autoCleanInterval * 60 * 60 * 1000);
    }

    // 注册指令
    /**
     * 会话设置的管理权限：群聊要求管理员，私聊里会话本身就是自己的作用域
     */
    const canManageSettings = async (session: Session): Promise<boolean> => {
        if (!session.guildId) return true;
        if (!session.userId) return false;
        return await isUserAdmin(session, session.userId);
    };

    const cmd = ctx.command('share', '分享解析插件配置', {authority: 1})
        .action(async ({session}) => {
            const scope = session && getSettingsScope(session);
            if (!scope) return '当前会话不可用。';
            const {parsers, nsfw} = await getEffectiveSettings(ctx, scope, config);
            const parserList = Object.entries(parsers)
                .map(([name, enabled]) => `${enabled ? '✅' : '❌'} ${name}`)
                .join('\n');
            return `当前解析器状态：\n${parserList}\nNSFW 内容：${nsfw ? '✅' : '❌'}`.trim();
        });

    cmd.subcommand('.parsers [parser:string] [mode:string]', '查看/管理当前会话的解析器状态', {authority: 1})
        .action(async ({session}, parser, value) => {
            const scope = session && getSettingsScope(session);
            if (!scope) return '当前会话不可用。';
            if (!await canManageSettings(session)) return '权限不足'
            type ParserName = typeof parsers_str[number];
            const isValidParser = (name: string): name is ParserName =>
                (parsers_str as readonly string[]).includes(name);

            if (!isValidParser(parser)) return '请输入正确的解析器名称';
            if (!value) return '请输入正确的模式';
            const mode = value.trim().toLowerCase() === 'true'

            const data = await ctx.database.get('sla_group_settings', scope);
            const final_parsers = {...data[0]?.custom_parsers, ...{[parser]: mode}};
            const record = {guildId: scope, custom_parsers: final_parsers};
            await ctx.database.upsert('sla_group_settings', [record]);
        });

    cmd.subcommand('.nsfw [value:string]', '设置是否允许 NSFW 内容', {authority: 1})
        .action(async ({session}, value) => {
            const scope = session && getSettingsScope(session);
            if (!scope) return '当前会话不可用。';
            if (!await canManageSettings(session)) return '权限不足'
            const mode = value.trim().toLowerCase() === 'true'
            const record = {guildId: scope, nsfw_enabled: mode};
            await ctx.database.upsert('sla_group_settings', [record]);
            await session.execute('share');
        });

    cmd.subcommand('.reset', '重置为全局默认设置', {authority: 1})
        .action(async ({session}) => {
            const scope = session && getSettingsScope(session);
            if (!scope) return '当前会话不可用。';
            if (!await canManageSettings(session)) return '权限不足'
            await ctx.database.remove('sla_group_settings', {guildId: scope});
            return '已重置为全局默认设置。';
        });

    cmd.subcommand('.migratecache', '迁移旧解析缓存到新时间线并校验', {authority: 4})
        .action(async () => {
            const result = await migrateLegacyParseCache(ctx);
            const status = result.mismatched === 0 ? '校验通过' : `校验失败 ${result.mismatched} 条`;
            return [
                '旧解析缓存迁移完成。',
                `旧解析缓存记录: ${result.legacyParse}`,
                `新增节点: ${result.migrated}`,
                `已存在/续期: ${result.skipped}`,
                `无效记录: ${result.invalid}`,
                status,
            ].join('\n');
        });

    cmd.subcommand('.migratecacheformat', '迁移解析/文件缓存到新 cacheKey 格式并合并重复节点', {authority: 4})
        .action(async () => {
            const timeline = await migrateTimelineCacheFormat(ctx);
            const fileCache = await migrateFileCacheFormat(ctx, timeline.fileCacheRemaps);
            return [
                '缓存格式迁移完成。',
                `时间线节点: ${timeline.totalNodes}`,
                `保留节点: ${timeline.keptNodes}`,
                `重写节点: ${timeline.rewrittenNodes}`,
                `重算 delta: ${timeline.deltaUpdatedNodes}`,
                `删除重复新节点: ${timeline.deduplicatedNodes}`,
                `无效 cache_key 节点: ${timeline.invalidCacheKeys}`,
                `文件缓存记录: ${fileCache.totalRows} -> ${fileCache.finalRows}`,
                `文件缓存迁移: ${fileCache.migratedRows}`,
                `文件缓存合并: ${fileCache.mergedRows}`,
                `文件缓存已是新格式/跳过: ${fileCache.skippedRows}`,
                `未找到旧文件缓存记录: ${fileCache.missingRows}`,
                `文件路径冲突: ${fileCache.conflictRows}`,
            ].join('\n');
        });

    cmd.subcommand('.dropoldcache', '删除旧 sla_parse_cache 数据/表', {authority: 4})
        .action(async () => {
            return await dropLegacyParseCache(ctx);
        });

    // 清除缓存指令
    cmd.subcommand('.clean', '清除所有缓存和文件', {authority: 3})
        .action(async () => {
            await ctx.database.remove('sla_parse_timeline', {});

            const allFiles = await ctx.database.get('sla_file_cache', {});
            for (const file of allFiles) {
                try {
                    if (fs.existsSync(file.path)) {
                        await fs.promises.unlink(file.path);
                    }
                } catch {
                }
            }
            await ctx.database.remove('sla_file_cache', {});
            return '缓存及对应文件已清理。';
        });

    cmd.subcommand('.checkcache <url:string> [index:string]', '查看缓存时间线/读取指定节点', {authority: 1})
        .action(async ({session}, url, index) => {
            if (!session) return '会话不可用。';
            if (!config.enableCache) return '缓存功能未启用。';

            const links = await resolveLinks(url, ctx, config);
            if (links.length === 0) return '未在该链接中识别到支持的内容。';
            const link = links[0];
            const cacheKey = `${link.platform}:${link.id}`;
            const nodes = await getTimelineNodes(ctx, cacheKey);

            if (!index) {
                if (nodes.length === 0) return `未找到历史节点: ${cacheKey}`;

                const latest = nodes[nodes.length - 1];
                const lines = [
                    `历史节点: ${cacheKey}`,
                    summarizeParsedInfo(latest.data),
                    ''
                ];

                nodes.forEach((node, nodeIndex) => {
                    lines.push(`#${nodeIndex + 1} | ${formatTime(node.created_at)}`);
                    lines.push(summarizeDelta(node.delta));
                });

                return lines.join('\n');
            }

            let selectedIndex: number;
            const normalizedIndex = index.trim().toLowerCase();
            if (normalizedIndex === 'l' || normalizedIndex === 'latest') {
                if (nodes.length === 0) return `未找到历史节点: ${cacheKey}`;
                selectedIndex = nodes.length;
            } else {
                selectedIndex = Number.parseInt(normalizedIndex, 10);
                if (!Number.isInteger(selectedIndex) || `${selectedIndex}` !== normalizedIndex || selectedIndex < 1) {
                    return '节点编号必须是从 1 开始的整数，或 l/latest。';
                }
            }

            const node = nodes[selectedIndex - 1];
            if (!node) return `节点不存在: #${selectedIndex}`;

            const result = {...node.data};
            result._cache = {
                ...result._cache,
                parse: `Timeline #${selectedIndex} | 节点时间: ${formatTime(node.created_at)}`
            };
            const sendStats = {downloadTime: 0, sendTime: 0, errors: [] as string[]};
            await sendResult(ctx, session, config, result, logger, sendStats);
            return;
        });

    cmd.subcommand('.forceparse <url:string>', '忽略缓存强制解析链接', {authority: 2})
        .action(async ({session}, url) => {
            if (!session) return '会话不可用。';
            const links = await resolveLinks(url, ctx, config);
            if (links.length === 0) return '未在该链接中识别到支持的内容。';
            const link = links[0];

            if (config.waitTip_Switch) await session.send(config.waitTip_Switch);

            const result = await processLink(ctx, config, link, session);
            if (!result) return `解析失败: ${link.platform}/${link.type}:${link.id}`;

            const cacheKey = `${link.platform}:${link.id}`;
            if (config.enableCache) {
                await upsertTimelineIfChanged(ctx, config, cacheKey, result);
                result._cache = {...result._cache, parse: `强制刷新 | 缓存时间: ${formatTime(Date.now())}`};
            }

            const sendStats = {downloadTime: 0, sendTime: 0, errors: [] as string[]};
            await sendResult(ctx, session, config, result, logger, sendStats);
            return;
        });

    cmd.subcommand('.forcecache <url:string>', '忽略缓存强制刷新缓存，不发送解析结果', {authority: 2})
        .action(async ({session}, url) => {
            if (!session) return '会话不可用。';
            if (!config.enableCache) return '缓存功能未启用。';

            const links = await resolveLinks(url, ctx, config);
            if (links.length === 0) return '未在该链接中识别到支持的内容。';
            const link = links[0];

            if (config.waitTip_Switch) await session.send(config.waitTip_Switch);

            const result = await processLink(ctx, config, link, session);
            if (!result) return `解析失败: ${link.platform}/${link.type}:${link.id}`;

            const cacheKey = `${link.platform}:${link.id}`;
            const node = await upsertTimelineIfChanged(ctx, config, cacheKey, result);
            return `缓存已强制刷新: ${cacheKey}\n时间: ${formatTime(node.last_checked_at || node.created_at)}`;
        });

    cmd.subcommand('.directlink <url:string> [quality:string]', '获取视频/音频直链', {authority: 1})
        .action(async ({session}, url, quality) => {
            if (!session) return '会话不可用。';
            const links = await resolveLinks(url, ctx, config);
            if (links.length === 0) return '未在该链接中识别到支持的内容。';
            const link = links[0];

            let clarity = config.Video_ClarityPriority;
            if (quality) {
                const q = quality.trim().toLowerCase();
                if (q === 'high' || q === 'h' || q === '高' || q === '高清晰度') {
                    clarity = '2' as const;
                } else if (q === 'low' || q === 'l' || q === '低' || q === '低清晰度') {
                    clarity = '1' as const;
                } else {
                    return `无效的画质参数: ${quality}。可用: high/h/高清晰度, low/l/低清晰度`;
                }
            }

            const modifiedConfig = {...config, Video_ClarityPriority: clarity, Max_size: Number.MAX_SAFE_INTEGER};
            const result = await processLink(ctx, modifiedConfig, link, session);
            if (!result) return `解析失败: ${link.platform}/${link.type}:${link.id}`;

            if (result.files.length === 0) {
                return `未获取到直链: ${link.platform}/${link.type}:${link.id}\n该内容类型可能不支持直链获取。`;
            }

            const clarityLabel = clarity === '2' ? '高清晰度优先' : '低清晰度优先';
            let output = `直链结果 (${link.platform}/${link.type}:${link.id}):\n画质策略: ${clarityLabel}\n标题: ${result.title}\n`;
            for (const [i, file] of result.files.entries()) {
                output += `\n[${i + 1}] ${file.type}: ${file.url}`;
            }
            return output;
        });

    cmd.subcommand('.refresh', '强制刷新所有 Cookie', {authority: 3})
        .action(async ({session}) => {
            await session?.send('🔄 开始执行 Cookie 全量刷新流程...');
            let msg = '';

            // 用于记录本次刷新覆盖了哪些平台，避免重复采集
            const refreshedPlatforms = new Set<string>();

            // ------------------------------------------------------
            // 1. 优先尝试云端同步 (CookieCloud)
            // ------------------------------------------------------
            if (config.cookieCloud?.enable) {
                try {
                    // syncCookiesFromCloud 内部已经完成了：获取 -> 比较 -> 存库
                    // 并返回成功获取到的 { platform: cookie }
                    const cloudCookies = await syncCookiesFromCloud(ctx, config);
                    const cloudCount = Object.keys(cloudCookies).length;

                    Object.keys(cloudCookies).forEach(p => refreshedPlatforms.add(p));

                    msg += `☁️ CookieCloud: 同步了 ${cloudCount} 个平台 [${Object.keys(cloudCookies).join(', ')}]\n`;
                } catch (e: any) {
                    msg += `❌ CookieCloud: 同步失败 - ${e.message}\n`;
                }
            } else {
                msg += `⏹ CookieCloud: 未启用\n`;
            }

            // ------------------------------------------------------
            // 2. 本地回退采集 (Local Fallback)
            // 只有当 Cloud 没有获取到某个平台的数据时，才触发本地采集
            // ------------------------------------------------------

            // 筛选出云端没覆盖到的，且支持本地采集的 parser
            const pendingParsers = parsers.filter(p =>
                !refreshedPlatforms.has(p.name) &&
                typeof p.lc_get_cookie === 'function'
            );

            if (pendingParsers.length > 0) {
                msg += `🔍 开始本地采集缺失的平台: [${pendingParsers.map(p => p.name).join(', ')}]\n`;

                // 并行执行本地采集
                const results = await Promise.all(pendingParsers.map(async (parser) => {
                    try {
                        // @ts-ignore (如果你没定义接口)
                        const cookie = await parser.lc_get_cookie(ctx, config);

                        if (cookie) {
                            // 本地采集成功，需要手动写入数据库
                            // 先检查一下是否真的变了（可选，upsert 也可以）
                            await ctx.database.upsert('sla_cookie_cache', [{
                                platform: parser.name,
                                cookie: cookie
                            }]);
                            return {name: parser.name, success: true};
                        }
                        // 获取为空，不做任何操作（保留数据库旧值）
                        return {name: parser.name, success: false, reason: 'Empty'};
                    } catch (e: any) {
                        return {name: parser.name, success: false, reason: e.message};
                    }
                }));

                // 汇总结果
                results.forEach(res => {
                    if (res.success) {
                        msg += `✅ 本地采集 [${res.name}]: 成功更新\n`;
                    } else {
                        // 只有报错或者显式失败才提示，如果是本来就没有则不打扰
                        if (res.reason !== 'Empty') {
                            msg += `❌ 本地采集 [${res.name}]: 失败 (${res.reason})\n`;
                        } else {
                            msg += `⚠️ 本地采集 [${res.name}]: 未获取到有效 Cookie (保持原状)\n`;
                        }
                    }
                });
            } else {
                msg += `✨ 所有支持的平台均已通过云端同步，无需本地采集。\n`;
            }

            return msg;
        });

    const lastProcessedUrls: Record<string, Record<string, number>> = {};

    ctx.on('ready', async () => {
        logger.info('插件启动，开始初始化检查...');

        // 1. 全局初始化
        await init(ctx, config);

        // 2. 尝试从 CookieCloud 同步
        // 获取云端数据 map，用于判断哪些平台已经就绪
        let cloudResult: Record<string, string> = {};
        if (config.cookieCloud?.enable) {
            logger.info('正在检查 CookieCloud...');
            cloudResult = await syncCookiesFromCloud(ctx, config);
        }

        // 3. 检查缺失的平台，触发本地采集
        // 逻辑：遍历所有 Parser，如果 Cloud 没返回它的 Cookie，并且它有 lc_get_cookie 方法，则尝试本地获取
        const localTasks = parsers.map(async (parser) => {
            // 如果云端已经成功拿到了，就跳过本地采集
            if (cloudResult[parser.name]) {
                return;
            }

            // 检查该 parser 是否支持获取 cookie
            if (typeof parser.lc_get_cookie === 'function') {
                try {
                    // 尝试本地获取
                    const localCookie = await parser.lc_get_cookie(ctx, config);

                    if (localCookie) {
                        // 获取成功，写入数据库
                        // 注意：这里我们做一个简单的 diff，如果数据库里已经有了且一样，就不写了（虽然 upsert 也不耗费啥资源）
                        const dbRecords = await ctx.database.get('sla_cookie_cache', {platform: parser.name});
                        if (dbRecords?.[0]?.cookie !== localCookie) {
                            await ctx.database.upsert('sla_cookie_cache', [{
                                platform: parser.name,
                                cookie: localCookie
                            }]);
                            logger.info(`[${parser.name}] 本地采集成功并更新数据库`);
                        }
                    } else {
                        // 既没有云端，本地也没获取到 -> 保持数据库原样 (Silent Fail)
                        logger.debug(`[${parser.name}] 本地采集未返回数据，跳过更新`);
                    }
                } catch (e) {
                    logger.warn(`[${parser.name}] 本地自动采集失败:`, e);
                }
            }
        });

        // 等待所有本地补救措施完成
        await Promise.all(localTasks);

        logger.info('初始化流程结束');
    });

    // 定时任务：每天检查一次 CookieCloud
    ctx.setInterval(async () => {
        logger.info('执行每日 CookieCloud 同步检查...');
        // syncCookiesFromCloud 内部会比对本地 DB，不一致才会更新
        await syncCookiesFromCloud(ctx, config);
    }, 24 * 60 * 60 * 1000);

    ctx.middleware(async (session, next) => {
        if (!session.content || !session.channelId) return next();

        const content = session.content.replace(/\\/g, '').replace(/&amp;/g, '&');
        const channelId = session.channelId;
        const links = await resolveLinks(content, ctx, config);

        if (links.length === 0) return next();

        let linkCount = 0;
        for (const link of links) {
            // 会话策略（群组自定义或全局默认）在解析前后都要用到，这里取一次
            const settings = await getEffectiveSettings(ctx, getSettingsScope(session), config);

            if (!settings.parsers[link.platform]) {
                logger.debug(`根据策略，该链接已被阻止解析：平台：${link.platform}，链接：${link.url}`);
                if (config.showError) await session.send(config.blockedMessage.replace(/\{platform\}/g, link.platform));
                continue
            }

            if (linkCount >= config.parseLimit) {
                await session.send("已达到单次解析上限…");
                break;
            }

            const now = Date.now();
            if (!lastProcessedUrls[channelId]) lastProcessedUrls[channelId] = {};
            if (now - (lastProcessedUrls[channelId][link.url] || 0) < config.Min_Interval * 1000) {
                logger.debug(`链接 ${link.url} 在冷却时间内，跳过处理。`);
                continue;
            }

            if (config.waitTip_Switch) {
                await session.send(config.waitTip_Switch);
            }

            // === 性能统计变量 ===
            const startTotal = Date.now();
            const sendStats: {
                downloadTime: number,
                sendTime: number,
                errors: string[],
                fileCacheHits?: number,
                fileCacheMisses?: number
            } = {
                downloadTime: 0,
                sendTime: 0,
                errors: []
            };
            let parseTime = 0;
            let status = "success";
            let errorMsg = "";
            let errorStack = "";

            // === 缓存与并发控制逻辑 ===
            let result: ParsedInfo | null = null;
            const cacheKey = `${link.platform}:${link.id}`;
            let optimisticData: ParsedInfo | null = null; // 用于暂存乐观缓存数据
            let optimisticTime = 0; // 记录乐观缓存的生成时间

            try {
                // 1. 查解析时间线的最新节点
                if (config.enableCache) {
                    const latestNode = await getLatestTimelineNode(ctx, config, cacheKey);
                    if (latestNode) {
                        const checkedAt = latestNode.last_checked_at || latestNode.created_at;
                        const ageMs = Date.now() - checkedAt;

                        // 分别判断是否超过 L1 和 乐观缓存 时效
                        const isExpiredL1 = config.cacheExpiration > 0 && (ageMs > config.cacheExpiration * 60 * 60 * 1000);
                        const isExpiredL2 = config.optimisticExpiration > 0 && (ageMs > config.optimisticExpiration * 60 * 60 * 1000);

                        if (!isExpiredL1) {
                            logger.debug(`使用 L1 缓存解析结果: ${cacheKey}`);
                            result = {...latestNode.data}; // 浅拷贝，避免修改污染原缓存对象
                            const cacheTimeStr = formatTime(checkedAt);
                            result._cache = {...result._cache, parse: `L1 命中 | 缓存时间: ${cacheTimeStr}`};
                        } else if (config.optimisticCache && !isExpiredL2) {
                            logger.debug(`L1 缓存已过期，暂存乐观缓存备用: ${cacheKey}`);
                            optimisticData = {...latestNode.data}; // 浅拷贝备用
                            optimisticTime = checkedAt;
                        }
                    }
                }

                // 2. 查内存任务队列
                if (!result) {
                    if (pendingChecks.has(cacheKey)) {
                        logger.debug(`检测到正在进行的解析任务，正在等待合并结果: ${cacheKey}`);
                        // 如果有相同的任务正在进行，直接等待它的结果
                        try {
                            result = await pendingChecks.get(cacheKey) || null;
                            // 若合并任务返回的结果带有乐观缓存标记
                            if (result && (result as any)._isOptimisticFallback) {
                                status = "optimistic_fallback";
                            }
                        } catch (e: any) {
                            let mergeErrDetail = e.message || String(e);
                            if (e.cause) {
                                const causeCode = e.cause.code || '';
                                const causeMsg = e.cause.message || String(e.cause);
                                mergeErrDetail += ` [cause: ${causeCode ? causeCode + ': ' : ''}${causeMsg}]`;
                            }
                            // 其他合并请求抛错时触发回退
                            if (optimisticData) {
                                logger.warn(`合并任务失败，触发乐观缓存回退: ${cacheKey} | Error: ${mergeErrDetail}`);
                                result = optimisticData;
                                const cacheTimeStr = formatTime(optimisticTime);
                                result._cache = {
                                    ...result._cache,
                                    parse: `L2 回退: 并发请求异常 | 缓存时间: ${cacheTimeStr}`
                                };
                                (result as any)._isOptimisticFallback = true;
                                status = "optimistic_fallback";
                            } else {
                                throw e;
                            }
                        }
                    } else {
                        // 如果没有，创建一个新的 Promise 任务
                        const task = (async () => {
                            const t = Date.now();
                            try {
                                const res = await processLink(ctx, config, link, session);

                                // 判断是否视为解析失败（返回 null）
                                if (!res) {
                                    if (optimisticData) {
                                        logger.warn(`API 返回 null，触发乐观缓存回退: ${cacheKey}`);
                                        const cacheTimeStr = formatTime(optimisticTime);
                                        optimisticData._cache = {
                                            ...optimisticData._cache,
                                            parse: `L2 回退: 解析数据为空 | 缓存时间: ${cacheTimeStr}`
                                        };
                                        (optimisticData as any)._isOptimisticFallback = true;
                                        return optimisticData;
                                    }
                                    return null;
                                }

                                // 解析成功且开启缓存，则写入 DB，刷新缓存时间戳
                                if (config.enableCache) {
                                    const cacheTime = Date.now();
                                    await upsertTimelineIfChanged(ctx, config, cacheKey, res);
                                    res._cache = {
                                        ...res._cache,
                                        parse: `未命中，已刷新 | 缓存时间: ${formatTime(cacheTime)}`
                                    };
                                }
                                return res;
                            } catch (e: any) {
                                // 构建包含根因的详细错误信息
                                let errDetail = e.message || String(e);
                                if (e.cause) {
                                    const causeCode = e.cause.code || '';
                                    const causeMsg = e.cause.message || String(e.cause);
                                    errDetail += ` [cause: ${causeCode ? causeCode + ': ' : ''}${causeMsg}]`;
                                }
                                // 抛出异常（网络错误/封禁）时触发乐观回退
                                if (optimisticData) {
                                    logger.warn(`解析抛出异常，触发乐观缓存回退: ${cacheKey} | Error: ${errDetail}`);
                                    const cacheTimeStr = formatTime(optimisticTime);
                                    optimisticData._cache = {
                                        ...optimisticData._cache,
                                        parse: `L2 回退: 接口异常 | 缓存时间: ${cacheTimeStr}`
                                    };
                                    (optimisticData as any)._isOptimisticFallback = true;
                                    return optimisticData;
                                }
                                logger.warn(`解析任务出错: ${errDetail}`);
                                throw e;
                            } finally {
                                // 执行上报
                                // 无论成功失败，都在 finally 中上报数据
                                parseTime = Date.now() - t;
                            }
                        })();

                        // 将任务存入 Map
                        pendingChecks.set(cacheKey, task);

                        try {
                            result = await task;
                            // 识别最终是否使用了乐观缓存回退
                            if (result && (result as any)._isOptimisticFallback) {
                                status = "optimistic_fallback";
                            }
                        } finally {
                            // 无论成功失败，任务结束后从 Map 中移除
                            pendingChecks.delete(cacheKey);
                        }
                    }
                }

                if (result) {
                    lastProcessedUrls[channelId][link.url] = Date.now();
                    // 敏感内容在会话层统一拦截：解析结果来自缓存时同样要过这一关
                    if (result.sensitive && !settings.nsfw) {
                        result = {
                            ...result,
                            mainbody: escapeHtml(config.sensitiveMessage),
                            coverUrl: undefined,
                            files: []
                        };
                    }
                    await sendResult(ctx, session, config, result, logger, sendStats);
                } else {
                    status = "failed";
                    errorMsg = "parser_returned_null";
                    // 即使没有抛错，如果返回 null，也可以视为一种“软失败”，记录一下
                }
                linkCount++;
            } catch (e: any) {
                status = "error";
                // 构建包含根因的详细错误信息
                let details = e.message || String(e);
                if (e.cause) {
                    const causeCode = e.cause.code || '';
                    const causeMsg = e.cause.message || String(e.cause);
                    details += ` [cause: ${causeCode ? causeCode + ': ' : ''}${causeMsg}]`;
                }
                if (e.response?.status) {
                    details += ` [HTTP ${e.response.status}]`;
                }
                errorMsg = details;
                errorStack = e.stack || String(e);
                logger.warn(`处理异常: ${details}`);
            } finally {
                // 4. 上报针对性排障数据
                const totalTime = Date.now() - startTotal;

                // 截取堆栈前 1000 个字符，防止数据包过大
                const truncatedStack = errorStack.length > 1000 ? errorStack.substring(0, 1000) + "..." : errorStack;

                if (status === "success" && sendStats.errors.length > 0) {
                    status = "partial_success";
                    errorMsg = sendStats.errors.join(' | ');
                }

                // 提取结果特征 (不上传庞大的明文，只上传数据维度，用于排查“是否少抓了图片”或“正文是否为空”)
                const resultFeatures = result ? {
                    res_title: result.title ? (result.title.length > 50 ? result.title.substring(0, 50) + '...' : result.title) : "无标题",
                    res_author: result.authorName || "未知",
                    res_has_cover: !!result.coverUrl,
                    res_files_count: result.files ? result.files.length : 0,
                    res_media_types: result.files ? result.files.map(f => f.type).join(',') : "",
                    res_mainbody_len: result.mainbody ? result.mainbody.length : 0,
                } : {};

                reportMetric(ctx, config, {
                    type: "link_process_trace", // 标识为详细的单次解析追踪记录

                    // === 1. 触发上下文 (精确复现用) ===
                    platform: link.platform,
                    link_type: link.type,       // 例如：opus, video, song, program
                    link_id: link.id,           // 解析出的资源核心 ID
                    target_url: link.url,

                    // === 2. 用户与会话上下文 ===
                    user_id: session.userId || "unknown",
                    guild_id: session.guildId || "private",
                    message_id: session.messageId || "unknown", // 用于在日志中溯源特定消息
                    raw_content_len: session.content ? session.content.length : 0, // 查明是否因长文本混排导致误触

                    // === 3. 执行状态与缓存命中 ===
                    status: status, // success, failed, error, optimistic_fallback
                    is_cache: (sendStats.fileCacheHits || 0) > 0,

                    // === 4. 关键排障配置状态 ===
                    // 记录当时的运行配置，排查是否是特定模式下才报错（如本地下载+混合发送）
                    cfg_using_local: config.usingLocal,
                    cfg_use_forward: config.useForward,
                    cfg_clarity: config.Video_ClarityPriority,

                    // === 5. 结果体特征 ===
                    ...resultFeatures,

                    // === 6. 错误追踪 ===
                    error_msg: errorMsg,
                    error_stack: truncatedStack,

                    // === 7. 耗时拆解 (性能瓶颈定位) ===
                    time_total_ms: totalTime,
                    time_parse_ms: parseTime,                   // 解析器发请求拉取数据的耗时
                    time_download_ms: sendStats.downloadTime,   // 代理下载图片/视频的耗时
                    time_send_ms: sendStats.sendTime,           // 组装并推给 QQ/Bot 平台的耗时
                });
            }
        }
    });
}
