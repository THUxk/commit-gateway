/**
 * Git Gateway Service
 * 基于 Cloudflare Workers 部署
 * 版本: 1.0.0
 *
 * 仅保留 GitHub 写入方法，所有 commit 自动写入 v2606 分支
 */

import { Router } from 'itty-router';

const router = Router();

// ========================================
// 常量定义
// ========================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
};

// ========================================
// 内存存储
// ========================================

let gitConfig = null;
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 60; // max requests per IP per window
const rateLimitStore = new Map();

// ========================================
// 工具函数
// ========================================

/**
 * 获取来源 IP
 */
function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

/**
 * 速率限制检查
 */
function checkRateLimit(request) {
  const ip = getClientIp(request);
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count += 1;
  rateLimitStore.set(ip, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    return new Response(JSON.stringify({
      error: 'Too many requests',
      error_description: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW / 1000} seconds.`
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  return null;
}


/**
 * 获取 Git 配置
 */
function getGitConfig(env) {
  if (gitConfig) {
    return gitConfig;
  }

  return {
    github_pat: env.GITHUB_PAT,
    committer_name: env.COMMITTER_NAME || 'Git Gateway',
    committer_email: env.COMMITTER_EMAIL || 'git@gateway.local',
    branch: env.GIT_BRANCH || 'main'
  };
}

/**
 * 获取仓库信息（固定为 THUxk/yourschool）
 */
async function getRepoInfo(request, env) {
  return {
    owner: 'THUxk',
    repo: 'yourschool',
    fullName: 'THUxk/yourschool'
  };
}

/**
 * 创建 GitHub API 请求头
 */
function createGitHubHeaders(pat) {
  return {
    'Authorization': `token ${pat}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Git-Gateway-Worker'
  };
}

/**
 * 创建错误响应
 */
function createErrorResponse(error, status = 500) {
  return new Response(JSON.stringify({
    error: error.name || 'Error',
    error_description: error.message || 'An error occurred'
  }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

/**
 * 生成动态分支名称：v+年份后两位+月份
 * 示例：v2606 (2026年6月)
 */
function getDynamicBranchName() {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `v${year}${month}`;
}

/**
 * 生成上一个月份的分支名称
 * 示例：当前 v2606，前一个月 v2605；v2601 前一个月为 v2512
 */
function getPreviousMonthBranchName() {
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = String(prevMonth.getFullYear()).slice(-2);
  const month = String(prevMonth.getMonth() + 1).padStart(2, '0');
  return `v${year}${month}`;
}

/**
 * 查询分支引用 SHA，如果不存在返回 null
 */
async function getBranchSha(owner, repo, branchName, pat) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: createGitHubHeaders(pat)
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data?.object?.sha || null;
}

/**
 * 检查分支是否存在
 */
async function branchExists(owner, repo, branchName, pat) {
  const sha = await getBranchSha(owner, repo, branchName, pat);
  return !!sha;
}

/**
 * 创建分支
 */
async function createBranch(owner, repo, branchName, baseSha, pat) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs`;
  const body = {
    ref: `refs/heads/${branchName}`,
    sha: baseSha
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: createGitHubHeaders(pat),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create branch: ${response.statusText}`);
  }

  return await response.json();
}

// ========================================
// CORS 预检处理
// ========================================

router.options('*', () => {
  return new Response(null, { headers: CORS_HEADERS });
});

// ========================================
// health 检查端点
// ========================================

router.get('/health', () => {
  return new Response(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
});

/**
 * POST /comment
 * 高层 API：一键提交文件到 data/ 目录，自动创建 commit 并推送到动态分支（如 v2606）
 *
 * 请求体示例：
 * {
 *   "content": "eyJuYW1lIjoiSm9obiJ9",   // base64 编码的文件内容
 *   "message": "Add user john",
 *   "encoding": "base64"                // 可选，默认为 'utf-8'；若 content 是 base64，请设为 'base64'
 * }
 */
router.post('/comment', async (request, env) => {
  try {
    const body = await request.json();
    const config = getGitConfig(env);
    const repoInfo = await getRepoInfo(request, env);

    if (!config.github_pat || !repoInfo) {
      return new Response(JSON.stringify({
        error: 'Repository configuration missing',
        error_description: 'GITHUB_PAT environment variable is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    // === 参数校验 ===
    const { content, message, encoding = 'utf-8' } = body;

    if (!content || typeof content !== 'string') {
      return new Response(JSON.stringify({
        error: 'Invalid content',
        error_description: 'Field "content" must be a string (use base64 for binary).'
      }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    const owner = repoInfo.owner;
    const repo = repoInfo.repo;
    const pat = config.github_pat;
    const targetBranch = getDynamicBranchName(); // e.g., v2606

    // === Step 1: 创建 Blob ===
    const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      headers: createGitHubHeaders(pat),
      body: JSON.stringify({ content, encoding })
    });

    if (!blobRes.ok) {
      const errText = await blobRes.text();
      console.error('Blob creation failed:', errText);
      return new Response(errText, {
        status: blobRes.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const blobData = await blobRes.json();
    const blobSha = blobData.sha;

    // === Step 2: 获取目标分支当前 HEAD 的 tree SHA ===
    let currentCommitSha = await getBranchSha(owner, repo, targetBranch, pat);

    // 如果目标分支不存在，尝试从上个月或 main 分支初始化
    if (!currentCommitSha) {
      const prevBranch = getPreviousMonthBranchName();
      currentCommitSha = await getBranchSha(owner, repo, prevBranch, pat);
      if (!currentCommitSha) {
        currentCommitSha = await getBranchSha(owner, repo, config.branch || 'main', pat);
      }
      if (!currentCommitSha) {
        return new Response(JSON.stringify({
          error: 'No base commit available',
          error_description: 'Could not find a valid base branch (tried dynamic, previous month, and main).'
        }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      // 自动创建目标分支（指向 base commit）
      await createBranch(owner, repo, targetBranch, currentCommitSha, pat);
    }

    // 获取当前 commit 的 root tree SHA
    const commitUrl = `https://api.github.com/repos/${owner}/${repo}/git/commits/${currentCommitSha}`;
    const commitRes = await fetch(commitUrl, { headers: createGitHubHeaders(pat) });
    if (!commitRes.ok) {
      throw new Error(`Failed to fetch commit ${currentCommitSha}: ${await commitRes.text()}`);
    }
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // === Step 3: 创建新 Tree（基于 base_tree）===
    const treePayload = {
      base_tree: baseTreeSha,
      tree: [
        {
          path: 'data/new.json',
          mode: '100644',
          type: 'blob',
          sha: blobSha
        }
      ]
    };

    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      headers: createGitHubHeaders(pat),
      body: JSON.stringify(treePayload)
    });

    if (!treeRes.ok) {
      const errText = await treeRes.text();
      console.error('Tree creation failed:', errText);
      return new Response(errText, {
        status: treeRes.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const treeData = await treeRes.json();
    const newTreeSha = treeData.sha;

    // === Step 4: 创建 Commit ===
    const commitPayload = {
      message: message,
      tree: newTreeSha,
      parents: [currentCommitSha]
    };

    const userAgent = request.headers.get('User-Agent') || 'unknown';
    const referer = request.headers.get('Referer') || request.headers.get('referer') || 'unknown';
    const clientIp = getClientIp(request);
    const clientInfo = `\n\nClient Info:\n- IP: ${clientIp}\n- User-Agent: ${userAgent}\n- Referer: ${referer}`;

    if (body && typeof body.message === 'string') {
      body.message = `${body.message}${clientInfo}`;
    }

    const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      headers: createGitHubHeaders(pat),
      body: JSON.stringify(commitPayload)
    });

    if (!newCommitRes.ok) {
      const errText = await newCommitRes.text();
      console.error('Commit creation failed:', errText);
      return new Response(errText, {
        status: newCommitRes.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const newCommitData = await newCommitRes.json();
    const newCommitSha = newCommitData.sha;

    // === Step 5: 更新分支引用 ===
    const updateRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${targetBranch}`, {
      method: 'PATCH',
      headers: createGitHubHeaders(pat),
      body: JSON.stringify({ sha: newCommitSha, force: false }) // 非强制更新，避免意外覆盖
    });

    if (!updateRefRes.ok) {
      const errText = await updateRefRes.text();
      console.error('Branch update failed:', errText);
      return new Response(errText, {
        status: updateRefRes.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    // === 成功响应 ===
    return new Response(JSON.stringify({
      success: true,
      path: 'data/new.json',
      branch: targetBranch,
      commit_sha: newCommitSha,
      blob_sha: blobSha,
      message: 'File successfully written to repository'
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });

  } catch (error) {
    console.error('Error in /comment:', error);
    return createErrorResponse(error, 500);
  }
});

// ========================================
// 404 处理
// ========================================

router.all('*', () => {
  return new Response(JSON.stringify({
    error: 'Not found',
    error_description: 'This endpoint is not available'
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
});

// ========================================
// 导出 Cloudflare Workers 入口
// ========================================

export default {
  fetch: async (request, env, ctx) => {
    const rateLimitResponse = checkRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    return router.handle(request, env, ctx).catch(error => {
      return new Response(JSON.stringify({
        error: error.message,
        error_description: 'Internal server error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    });
  }
};
