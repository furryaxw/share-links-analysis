// src/parsers/github.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, numeral} from '../utils';

export const name = "github";

const API_BASE = 'https://api.github.com';

// 列表类链接单次展示的条目数
const LIST_LIMIT = 10;

// 发行版正文摘要的最大长度
const RELEASE_BODY_LIMIT = 300;

type LinkType = 'repo' | 'tree' | 'branches' | 'tags' | 'releases' | 'release' | 'user' | 'org';

interface GithubLink {
    type: LinkType;
    id: string;
    url: string;
}

// 匹配消息中的 github.com 链接（左边界排除 api./gist. 等子域，允许 www.）
const LINK_PATTERN = /(?<![\w.-])(?:www\.)?github\.com\/([^\s<>"'`]+)/gi;

// GitHub 路径里允许出现的字符，用于在中文标点等字符处截断
const PATH_CHARS = /[^A-Za-z0-9._~%+\-@/].*$/;

// github.com 下指向站点功能而非用户/仓库的保留路径
const RESERVED_PATHS = new Set([
    'about', 'account', 'apps', 'blog', 'changelog', 'codespaces', 'collections', 'contact',
    'copilot', 'customer-stories', 'dashboard', 'education', 'enterprise', 'events', 'explore',
    'features', 'github-copilot', 'join', 'login', 'logout', 'marketplace', 'mobile', 'models',
    'new', 'nonprofit', 'notifications', 'organizations', 'orgs', 'pricing', 'premium-support',
    'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sitemap',
    'sponsors', 'status', 'team', 'topics', 'trending', 'users', 'wiki',
]);

function isValidOwner(value: string): boolean {
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

function isValidRepo(value: string): boolean {
    return /^[A-Za-z0-9._-]{1,100}$/.test(value);
}

/**
 * 把 github.com/ 之后的路径解析成受支持的链接类型
 */
function parseGithubPath(segments: string[]): GithubLink | null {
    if (!segments.length) return null;

    // github.com/orgs/<org> 与 github.com/<org> 指向同一个组织主页
    if (segments[0].toLowerCase() === 'orgs') {
        const login = segments[1];
        if (!login || segments.length > 2 || !isValidOwner(login)) return null;
        return {type: 'org', id: login, url: `https://github.com/${login}`};
    }

    if (segments.length === 1) {
        const login = segments[0];
        if (RESERVED_PATHS.has(login.toLowerCase()) || !isValidOwner(login)) return null;
        return {type: 'user', id: login, url: `https://github.com/${login}`};
    }

    const owner = segments[0];
    if (RESERVED_PATHS.has(owner.toLowerCase()) || !isValidOwner(owner)) return null;

    let repo = segments[1];
    if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
    if (!isValidRepo(repo) || repo === '.' || repo === '..') return null;

    const base = `${owner}/${repo}`;
    const repoUrl = `https://github.com/${base}`;

    if (segments.length === 2) {
        return {type: 'repo', id: base, url: repoUrl};
    }

    const action = segments[2].toLowerCase();
    const rest = segments.slice(3);

    if (action === 'tree' && rest.length > 0) {
        const refPath = rest.join('/');
        return {type: 'tree', id: `${base}/tree/${refPath}`, url: `${repoUrl}/tree/${refPath}`};
    }

    if (action === 'branches' && rest.length === 0) {
        return {type: 'branches', id: `${base}/branches`, url: `${repoUrl}/branches`};
    }

    if (action === 'tags' && rest.length === 0) {
        return {type: 'tags', id: `${base}/tags`, url: `${repoUrl}/tags`};
    }

    if (action === 'releases') {
        if (rest.length === 0) {
            return {type: 'releases', id: `${base}/releases`, url: `${repoUrl}/releases`};
        }
        if (rest.length === 1 && rest[0].toLowerCase() === 'latest') {
            return {type: 'release', id: `${base}/releases/latest`, url: `${repoUrl}/releases/latest`};
        }
        if (rest[0].toLowerCase() === 'tag' && rest.length > 1) {
            const tag = rest.slice(1).join('/');
            return {type: 'release', id: `${base}/releases/tag/${tag}`, url: `${repoUrl}/releases/tag/${tag}`};
        }
    }

    return null;
}

/**
 * 去掉查询串、锚点与句末标点，并切分成路径片段
 */
function normalizePath(raw: string): string[] {
    const path = raw
        .replace(PATH_CHARS, '')
        .replace(/[.,;:!?]+$/, '')
        .replace(/\/+$/, '');
    return path.split('/').filter(Boolean).map((segment) => {
        try {
            return decodeURIComponent(segment);
        } catch {
            return segment;
        }
    });
}

/**
 * 在文本中匹配 GitHub 链接
 */
export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();

    LINK_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_PATTERN.exec(content)) !== null) {
        const parsed = parseGithubPath(normalizePath(m[1]));
        if (!parsed) continue;
        if (seen.has(parsed.id)) continue;
        seen.add(parsed.id);
        results.push({
            platform: name,
            type: parsed.type,
            id: parsed.id,
            url: parsed.url,
        });
    }

    return results;
}

function getGithubToken(config: PluginConfig): string {
    const raw = String(config.githubToken || '').trim();
    // 允许直接粘贴 "Bearer xxx" 或 "token xxx"
    return raw.replace(/^(?:bearer|token)\s+/i, '');
}

function requestOptions(config: PluginConfig): any {
    const options: any = {
        headers: {
            'User-Agent': config.userAgent,
            'Accept': 'application/vnd.github.v3+json',
        },
    };
    const token = getGithubToken(config);
    if (token) {
        options.headers.Authorization = `Bearer ${token}`;
    }
    // 适配插件全局配置里的代理选项
    if (config.proxy_settings[name] && config.proxy) {
        options.proxyAgent = config.proxy;
    }
    return options;
}

async function getOptional(ctx: Context, config: PluginConfig, url: string): Promise<any | null> {
    try {
        return await ctx.http.get(url, requestOptions(config));
    } catch {
        return null;
    }
}

function formatDate(value?: string | null): string {
    if (!value) return '未知';
    const date = new Date(value);
    if (isNaN(date.getTime())) return '未知';
    return date.toLocaleString('zh-CN', {hour12: false});
}

function shortSha(sha?: string | null): string {
    return sha ? sha.slice(0, 7) : '';
}

function repoApiUrl(owner: string, repo: string): string {
    return `${API_BASE}/repos/${owner}/${repo}`;
}

function socialifyFlag(value: boolean | undefined, fallback: boolean): string {
    return (value === undefined ? fallback : value) ? '1' : '0';
}

function buildSocialifyUrl(config: PluginConfig, owner: string, repo: string): string {
    // Socialify 的 /image 返回 SVG，部分适配器无法发送，这里固定取 /png
    const params = [
        `font=${encodeURIComponent(config.socialifyFont || 'Inter')}`,
        `theme=${encodeURIComponent(config.socialifyTheme || 'Light')}`,
        `pattern=${encodeURIComponent(config.socialifyPattern || 'Plus')}`,
        `language=${socialifyFlag(config.socialifyLanguage, true)}`,
        `owner=${socialifyFlag(config.socialifyOwner, true)}`,
        `name=${socialifyFlag(config.socialifyName, true)}`,
        `description=${socialifyFlag(config.socialifyDescription, false)}`,
        `stargazers=${socialifyFlag(config.socialifyStars, true)}`,
        `forks=${socialifyFlag(config.socialifyForks, true)}`,
        `issues=${socialifyFlag(config.socialifyIssues, false)}`,
        `pulls=${socialifyFlag(config.socialifyPulls, false)}`,
    ];
    return `https://socialify.git.ci/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/png?${params.join('&')}`;
}

/**
 * 生成仓库封面图地址，用户/组织主页没有对应预览图，返回空
 */
function buildCoverUrl(config: PluginConfig, owner: string, repo?: string): string {
    if (!repo) return '';
    const mode = config.githubCover || 'off';
    if (mode === 'off') return '';

    if (mode === 'socialify') {
        return buildSocialifyUrl(config, owner, repo);
    }

    return `https://opengraph.githubassets.com/1/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * 解析单个 GitHub 链接
 */
export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    const segments = link.id.split('/');
    const [owner, repo] = segments;

    try {
        switch (link.type) {
            case 'user':
            case 'org':
                return await processProfile(ctx, config, link, owner, logger);
            case 'repo':
                return await processRepo(ctx, config, link, owner, repo, logger);
            case 'tree':
                return await processTree(ctx, config, link, owner, repo, segments.slice(3), logger);
            case 'branches':
            case 'tags':
                return await processRefList(ctx, config, link, owner, repo, logger);
            case 'releases':
                return await processReleaseList(ctx, config, link, owner, repo, logger);
            case 'release':
                return await processRelease(ctx, config, link, owner, repo, segments.slice(3), logger);
            default:
                return null;
        }
    } catch (error: any) {
        const status = error?.response?.status;
        logger.error(`GitHub 解析失败: ${status ? `[HTTP ${status}] ` : ''}${error.message}`);
        if (status === 401) {
            logger.error('GitHub Token 无效，请检查「GitHub 解析设置」中的 Token');
        } else if (status === 403 || status === 429) {
            logger.warn('GitHub API 速率限制已用尽，可在「GitHub 解析设置」配置 Token 提升上限');
        }
        return null;
    }
}

/**
 * 仓库主页
 */
async function processRepo(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    owner: string,
    repo: string,
    logger: any
): Promise<ParsedInfo | null> {
    const repoUrl = repoApiUrl(owner, repo);

    logger.debug(`正在请求 GitHub API: ${repoUrl}`);
    const res = await ctx.http.get(repoUrl, requestOptions(config));

    if (!res || !res.full_name) {
        throw new Error('GitHub API 返回数据无效或仓库不存在');
    }

    // 尝试获取最新 Release（如果失败静默忽略，防止因限流导致整个卡片解析失败）
    let latestRelease = '';
    try {
        const releaseRes = await ctx.http.get(`${repoUrl}/releases/latest`, requestOptions(config));
        if (releaseRes && releaseRes.tag_name) {
            latestRelease = releaseRes.tag_name;
        }
    } catch (e) {
        logger.debug(`获取 Release 失败或触发限流: ${link.id}`);
    }

    const title = res.full_name;
    const authorName = res.owner?.login || 'Unknown';

    // 提取高价值静态数据
    const topics = res.topics && res.topics.length > 0 ? res.topics.slice(0, 5).join(', ') : '';
    const updatedAt = formatDate(res.pushed_at || res.updated_at);

    const stars = numeral(res.stargazers_count, config);
    const forks = numeral(res.forks_count, config);
    const watchers = numeral(res.subscribers_count || res.watchers_count, config);
    const issues = numeral(res.open_issues_count, config);

    const statsString = `Stars: ${stars} | Forks: ${forks} | Watchers: ${watchers} | Issues: ${issues}`;

    // 组装精炼的正文排版
    let finalBody = res.description ? escapeHtml(res.description) : '暂无描述';

    // 补充 Fork 信息：判断是否为派生仓库
    if (res.fork && res.parent?.full_name) {
        finalBody = `Forked from: ${res.parent.full_name}\n\n` + finalBody;
    }

    if (topics) {
        finalBody += `\n标签: ${escapeHtml(topics)}`;
    }

    finalBody += `\n\n更新时间: ${updatedAt}`;

    const metaInfo = [];
    if (res.language) metaInfo.push(`语言: ${res.language}`);
    if (latestRelease) metaInfo.push(`版本: ${latestRelease}`);
    if (res.license?.spdx_id) metaInfo.push(`协议: ${res.license.spdx_id}`);

    if (metaInfo.length > 0) {
        finalBody += `\n` + metaInfo.join(' | ');
    }

    return {
        platform: name,
        title: title,
        authorName: authorName,
        mainbody: finalBody,
        coverUrl: buildCoverUrl(config, owner, repo),
        files: [],
        sourceUrl: res.html_url,
        stats: statsString,
    };
}

/**
 * 用户或组织主页
 */
async function processProfile(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    login: string,
    logger: any
): Promise<ParsedInfo | null> {
    const data = await ctx.http.get(`${API_BASE}/users/${encodeURIComponent(login)}`, requestOptions(config));
    if (!data || !data.login) {
        throw new Error('GitHub 用户或组织不存在');
    }

    const isOrg = data.type === 'Organization';
    // /users 接口不返回组织简介，组织主页需要再取一次 /orgs
    const orgData = isOrg ? await getOptional(ctx, config, `${API_BASE}/orgs/${encodeURIComponent(login)}`) : null;
    const description = orgData?.description || data.description || data.bio;

    const lines: string[] = [];
    if (description) lines.push(escapeHtml(String(description)));
    if (data.company) lines.push(`公司: ${escapeHtml(data.company)}`);
    if (data.location) lines.push(`位置: ${escapeHtml(data.location)}`);
    if (data.blog) lines.push(`主页: ${escapeHtml(data.blog)}`);
    if (data.twitter_username) lines.push(`Twitter: @${escapeHtml(data.twitter_username)}`);
    lines.push(`类型: ${isOrg ? '组织' : '用户'}${orgData?.is_verified ? ' (已认证)' : ''}`);
    lines.push(`创建时间: ${formatDate(data.created_at)}`);

    const statsString = [
        `仓库: ${numeral(data.public_repos || 0, config)}`,
        `关注者: ${numeral(data.followers || 0, config)}`,
        `关注: ${numeral(data.following || 0, config)}`,
    ].join(' | ');

    return {
        platform: name,
        title: data.name || data.login,
        authorName: data.login,
        mainbody: lines.join('\n'),
        coverUrl: '',
        files: [],
        sourceUrl: data.html_url || link.url,
        stats: statsString,
    };
}

interface ResolvedRef {
    ref: string;
    kind?: 'branch' | 'tag';
    path: string;
    commit: any | null;
}

async function getLatestCommit(
    ctx: Context,
    config: PluginConfig,
    owner: string,
    repo: string,
    ref: string
): Promise<any | null> {
    try {
        const url = `${repoApiUrl(owner, repo)}/commits?sha=${encodeURIComponent(ref)}&per_page=1`;
        const res = await ctx.http.get(url, requestOptions(config));
        return Array.isArray(res) && res.length > 0 ? res[0] : null;
    } catch {
        return null;
    }
}

async function listRefNames(
    ctx: Context,
    config: PluginConfig,
    owner: string,
    repo: string,
    kind: 'branches' | 'tags'
): Promise<string[]> {
    try {
        const res = await ctx.http.get(`${repoApiUrl(owner, repo)}/${kind}?per_page=100`, requestOptions(config));
        if (!Array.isArray(res)) return [];
        return res.map((item: any) => item?.name).filter((value: any): value is string => typeof value === 'string');
    } catch {
        return [];
    }
}

/**
 * 在已知引用名中找出与路径片段前缀最长匹配的一项
 */
function longestRefPrefix(names: string[], segments: string[]): { ref: string, path: string } | null {
    let best: { ref: string, path: string } | null = null;
    let bestLength = 0;

    for (const ref of names) {
        const parts = ref.split('/');
        if (parts.length === 0 || parts.length > segments.length || parts.length <= bestLength) continue;
        let matched = true;
        for (let i = 0; i < parts.length; i++) {
            if (parts[i] !== segments[i]) {
                matched = false;
                break;
            }
        }
        if (!matched) continue;
        best = {ref, path: segments.slice(parts.length).join('/')};
        bestLength = parts.length;
    }

    return best;
}

/**
 * 解析 /tree/<ref> 里的引用：<ref> 之后可能还跟着目录路径，分支/标签名本身也可能带斜杠
 */
async function resolveTreeRef(
    ctx: Context,
    config: PluginConfig,
    owner: string,
    repo: string,
    segments: string[],
    logger: any
): Promise<ResolvedRef | null> {
    if (segments.length === 0) return null;

    // 单段时不存在歧义，直接当作引用
    if (segments.length === 1) {
        const commit = await getLatestCommit(ctx, config, owner, repo, segments[0]);
        if (!commit) return null;
        return {ref: segments[0], path: '', commit};
    }

    // 先尝试整段作为引用，例如分支 feature/xxx
    const full = segments.join('/');
    const fullCommit = await getLatestCommit(ctx, config, owner, repo, full);
    if (fullCommit) {
        return {ref: full, path: '', commit: fullCommit};
    }

    const branches = await listRefNames(ctx, config, owner, repo, 'branches');
    const branchHit = longestRefPrefix(branches, segments);
    if (branchHit) {
        const commit = await getLatestCommit(ctx, config, owner, repo, branchHit.ref);
        if (commit) return {ref: branchHit.ref, kind: 'branch', path: branchHit.path, commit};
    }

    const tags = await listRefNames(ctx, config, owner, repo, 'tags');
    const tagHit = longestRefPrefix(tags, segments);
    if (tagHit) {
        const commit = await getLatestCommit(ctx, config, owner, repo, tagHit.ref);
        if (commit) return {ref: tagHit.ref, kind: 'tag', path: tagHit.path, commit};
    }

    // 兜底：把首段当作引用，其余部分当作目录
    logger.debug(`无法在分支/标签列表中确认引用，按首段解析: ${segments[0]}`);
    const fallbackCommit = await getLatestCommit(ctx, config, owner, repo, segments[0]);
    if (!fallbackCommit) return null;
    return {ref: segments[0], path: segments.slice(1).join('/'), commit: fallbackCommit};
}

/**
 * 分支或标签页面
 */
async function processTree(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    owner: string,
    repo: string,
    segments: string[],
    logger: any
): Promise<ParsedInfo | null> {
    const resolved = await resolveTreeRef(ctx, config, owner, repo, segments, logger);
    if (!resolved) {
        throw new Error('未找到对应的分支或标签');
    }

    const {ref, kind, path, commit} = resolved;
    const kindLabel = kind === 'branch' ? '分支' : kind === 'tag' ? '标签' : '引用';

    const lines: string[] = [];
    lines.push(`仓库: ${owner}/${repo}`);
    lines.push(`${kindLabel}: ${ref}`);
    if (path) lines.push(`路径: ${path}`);

    let commitAuthor = '';
    let commitDate = '';
    if (commit) {
        const message = String(commit.commit?.message || '').split('\n').filter(Boolean);
        if (message.length > 0) {
            lines.push('');
            lines.push(escapeHtml(message.slice(0, 2).join('\n')));
        }
        commitAuthor = commit.author?.login || commit.commit?.author?.name || '';
        commitDate = formatDate(commit.commit?.committer?.date || commit.commit?.author?.date);

        const commitLine = [
            shortSha(commit.sha),
            commitAuthor,
            commitDate,
        ].filter(Boolean).join(' | ');
        lines.push('');
        lines.push(`提交: ${escapeHtml(commitLine)}`);
    }

    const title = path ? `${owner}/${repo} · ${ref}/${path}` : `${owner}/${repo} · ${ref}`;

    return {
        platform: name,
        title,
        authorName: commitAuthor || owner,
        mainbody: lines.join('\n'),
        coverUrl: buildCoverUrl(config, owner, repo),
        files: [],
        sourceUrl: link.url,
        stats: commitDate ? `最近提交: ${commitDate}` : '',
    };
}

/**
 * 分支列表或标签列表页面
 */
async function processRefList(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    owner: string,
    repo: string,
    logger: any
): Promise<ParsedInfo | null> {
    const kind = link.type === 'branches' ? 'branches' : 'tags';
    const label = kind === 'branches' ? '分支' : '标签';

    logger.debug(`正在请求 GitHub API: ${repoApiUrl(owner, repo)}/${kind}`);
    const res = await ctx.http.get(
        `${repoApiUrl(owner, repo)}/${kind}?per_page=${LIST_LIMIT}`,
        requestOptions(config)
    );

    if (!Array.isArray(res)) {
        throw new Error(`GitHub API 返回的${label}列表无效`);
    }

    const lines = res.length > 0
        ? res.map((item: any) => {
            const sha = shortSha(item?.commit?.sha);
            const extra = item?.protected ? ' (受保护)' : '';
            return `- ${escapeHtml(String(item?.name || ''))}${sha ? ` (${sha})` : ''}${extra}`;
        })
        : [`暂无${label}`];

    return {
        platform: name,
        title: `${owner}/${repo} · ${label}列表`,
        authorName: owner,
        mainbody: lines.join('\n'),
        coverUrl: buildCoverUrl(config, owner, repo),
        files: [],
        sourceUrl: link.url,
        stats: res.length > 0 ? `显示前 ${res.length} 个` : '',
    };
}

/**
 * 发行版列表页面
 */
async function processReleaseList(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    owner: string,
    repo: string,
    logger: any
): Promise<ParsedInfo | null> {
    logger.debug(`正在请求 GitHub API: ${repoApiUrl(owner, repo)}/releases`);
    const res = await ctx.http.get(
        `${repoApiUrl(owner, repo)}/releases?per_page=${LIST_LIMIT}`,
        requestOptions(config)
    );

    if (!Array.isArray(res)) {
        throw new Error('GitHub API 返回的发行版列表无效');
    }

    const lines = res.length > 0
        ? res.map((item: any) => {
            const name = item?.name || item?.tag_name || '未命名';
            const tags = [
                item?.prerelease ? '预发布' : '',
                item?.draft ? '草稿' : '',
            ].filter(Boolean).join('、');
            const date = item?.published_at ? formatDate(item.published_at) : '未发布';
            return `- ${escapeHtml(String(name))} (${escapeHtml(String(item?.tag_name || ''))}) · ${date}${tags ? ` [${tags}]` : ''}`;
        })
        : ['暂无发行版'];

    return {
        platform: name,
        title: `${owner}/${repo} · 发行版列表`,
        authorName: owner,
        mainbody: lines.join('\n'),
        coverUrl: buildCoverUrl(config, owner, repo),
        files: [],
        sourceUrl: link.url,
        stats: res.length > 0 ? `显示前 ${res.length} 个` : '',
    };
}

/**
 * 发行版详情，支持 /releases/latest 与 /releases/tag/<tag>
 */
async function processRelease(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    owner: string,
    repo: string,
    segments: string[],
    logger: any
): Promise<ParsedInfo | null> {
    const repoUrl = repoApiUrl(owner, repo);
    let data: any;

    if (segments.length === 1 && segments[0].toLowerCase() === 'latest') {
        logger.debug(`正在请求 GitHub API: ${repoUrl}/releases/latest`);
        data = await ctx.http.get(`${repoUrl}/releases/latest`, requestOptions(config));
    } else if (segments[0]?.toLowerCase() === 'tag' && segments.length > 1) {
        const tag = segments.slice(1).join('/');
        logger.debug(`正在请求 GitHub API: ${repoUrl}/releases/tags/${tag}`);
        data = await ctx.http.get(`${repoUrl}/releases/tags/${encodeURIComponent(tag)}`, requestOptions(config));
    } else {
        return null;
    }

    if (!data || !data.tag_name) {
        throw new Error('GitHub API 返回的发行版数据无效');
    }

    const assets = Array.isArray(data.assets) ? data.assets : [];
    const downloads = assets.reduce((sum: number, asset: any) => sum + (asset?.download_count || 0), 0);

    const lines: string[] = [];
    lines.push(`仓库: ${owner}/${repo}`);
    lines.push(`标签: ${escapeHtml(String(data.tag_name))}`);
    lines.push(`发布: ${formatDate(data.published_at || data.created_at)}`);

    const flags = [
        data.prerelease ? '预发布' : '',
        data.draft ? '草稿' : '',
    ].filter(Boolean);
    if (flags.length > 0) lines.push(`状态: ${flags.join('、')}`);
    if (data.author?.login) lines.push(`发布者: ${escapeHtml(data.author.login)}`);

    const body = String(data.body || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (body) {
        const excerpt = body.length > RELEASE_BODY_LIMIT
            ? body.slice(0, RELEASE_BODY_LIMIT) + '…'
            : body;
        lines.push('');
        lines.push(escapeHtml(excerpt));
    }

    return {
        platform: name,
        title: data.name || data.tag_name,
        authorName: data.author?.login || owner,
        mainbody: lines.join('\n'),
        coverUrl: buildCoverUrl(config, owner, repo),
        files: [],
        sourceUrl: data.html_url || link.url,
        stats: `附件: ${assets.length} | 下载: ${numeral(downloads, config)}`,
    };
}
