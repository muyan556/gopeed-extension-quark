/**
 * Gopeed 夸克网盘解析扩展
 * 支持解析夸克分享链接，包括密码保护的分享和文件夹
 * @version 1.0.0
 * @author muyan556
 */

// ================= 配置常量 =================
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const API_BASE_URL = "https://pan.quark.cn";
const DRIVE_BASE_URL = "https://drive-pc.quark.cn";
const MAX_RETRY = 3;
const RETRY_DELAY = 1000;

// ================= 工具函数 =================

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从分享链接中解析出 pwdId 和 passcode
 * @param {string} url - 分享链接
 * @returns {{pwdId: string, passcode: string}}
 */
function parseShareUrl(url) {
    if (!url || typeof url !== 'string') {
        throw new Error('无效的分享链接');
    }

    // 清理 URL 中的干扰字符
    const clean = url.replace(/\[.*?\]/g, '').trim();
    let pwdId = '';
    let passcode = '';

    // 提取 pwdId
    const idMatch = clean.match(/\/s\/([a-zA-Z0-9]+)/);
    if (idMatch && idMatch[1]) {
        pwdId = idMatch[1];
    } else if (clean.length > 10 && clean.match(/^[a-zA-Z0-9]+$/)) {
        pwdId = clean;
    }

    // 提取密码
    const pwMatch = clean.match(/[?&](pwd|password|pw)=([a-zA-Z0-9]{4})/i);
    if (pwMatch && pwMatch[2]) {
        passcode = pwMatch[2];
    }

    if (!pwdId) {
        throw new Error('无法从链接中解析出分享 ID，请检查链接格式');
    }

    return { pwdId, passcode };
}

/**
 * 发送 API 请求（带重试机制）
 * @param {string} url - API 地址
 * @param {string} method - 请求方法
 * @param {object} data - 请求数据
 * @param {number} retryCount - 当前重试次数
 * @returns {Promise<object>}
 */
async function requestApi(url, method, data = {}, retryCount = 0) {
    const cookie = gopeed.settings.cookie;
    if (!cookie) {
        throw new Error('未配置 Cookie，请在扩展设置中配置夸克 Cookie');
    }

    const headers = {
        'Cookie': cookie,
        'User-Agent': USER_AGENT,
        'Referer': `${API_BASE_URL}/`,
        'Origin': API_BASE_URL,
        'Content-Type': 'application/json;charset=UTF-8'
    };

    const options = {
        method: method,
        headers: headers
    };

    if (method === 'POST') {
        options.body = JSON.stringify(data);
    }

    try {
        gopeed.logger.debug(`请求 [${method}]: ${url}`);

        const response = await fetch(url, options);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        gopeed.logger.debug(`响应: ${JSON.stringify(result).substring(0, 200)}...`);

        return result;
    } catch (error) {
        // 重试逻辑
        if (retryCount < MAX_RETRY) {
            gopeed.logger.warn(`请求失败，${RETRY_DELAY}ms 后重试 (${retryCount + 1}/${MAX_RETRY}): ${error.message}`);
            await sleep(RETRY_DELAY);
            return requestApi(url, method, data, retryCount + 1);
        }
        throw new Error(`请求失败: ${error.message}`);
    }
}

/**
 * 获取 Token (包含 passcode)
 * @param {string} pwdId - 分享 ID
 * @param {string} passcode - 分享密码
 * @returns {Promise<object>}
 */
async function apiGetToken(pwdId, passcode) {
    const url = `${API_BASE_URL}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&__dt=${Date.now()}`;
    const data = {
        pwd_id: pwdId,
        passcode: passcode || ''
    };

    const res = await requestApi(url, 'POST', data);

    if (res.code !== 0) {
        const errorMsg = res.message || '获取 Token 失败';
        if (res.code === 31001) {
            throw new Error(`${errorMsg}（错误码: 31001）- 分享链接需要密码，请在 URL 中添加密码参数，例如: ?pwd=1234`);
        } else if (res.code === 31002) {
            throw new Error(`${errorMsg}（错误码: 31002）- 分享链接已失效或被取消`);
        } else {
            throw new Error(`${errorMsg}（错误码: ${res.code}）`);
        }
    }

    return res.data;
}

/**
 * 获取文件/文件夹详情
 * @param {string} pwdId - 分享 ID
 * @param {string} stoken - 分享 Token
 * @param {string} pdirFid - 父文件夹 ID
 * @returns {Promise<object>}
 */
async function apiGetDetail(pwdId, stoken, pdirFid = '') {
    const url = `${API_BASE_URL}/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${pdirFid}&force=0&_page=1&_size=1000&_fetch_banner=1&_fetch_share=1&_fetch_total=1&_sort=file_type:asc,updated_at:desc&__dt=${Date.now()}`;

    const res = await requestApi(url, 'GET');

    if (res.code !== 0) {
        throw new Error(`${res.message || '获取文件列表失败'}（错误码: ${res.code}）`);
    }

    return res.data;
}

/**
 * 转存文件到自己的网盘
 * @param {string} pwdId - 分享 ID
 * @param {string} stoken - 分享 Token
 * @param {Array} fidList - 文件 ID 列表
 * @param {Array} fidTokenList - 文件 Token 列表
 * @returns {Promise<string>}
 */
async function apiSaveFile(pwdId, stoken, fidList, fidTokenList) {
    const url = `${DRIVE_BASE_URL}/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=`;
    const data = {
        fid_list: fidList,
        fid_token_list: fidTokenList,
        to_pdir_fid: "0",
        pwd_id: pwdId,
        stoken: stoken,
        pdir_fid: "0",
        scene: "link"
    };

    const res = await requestApi(url, 'POST', data);

    if (res.code !== 0) {
        throw new Error(`${res.message || '转存失败'}（错误码: ${res.code}）- 可能是 Cookie 已过期或网盘空间不足`);
    }

    return res.data ? res.data.task_id : null;
}

/**
 * 轮询转存任务状态
 * @param {string} taskId - 任务 ID
 * @returns {Promise<Array>}
 */
async function apiPollTask(taskId) {
    const MAX_POLLS = 30;

    for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(1000);

        const url = `${DRIVE_BASE_URL}/1/clouddrive/task?pr=ucpro&fr=pc&uc_param_str=&task_id=${taskId}&retry_index=0&__dt=${Date.now()}`;
        const res = await requestApi(url, 'GET');

        if (res.data && res.data.status === 2) {
            gopeed.logger.info('转存任务完成');
            return res.data.save_as?.save_as_top_fids || [];
        } else if (res.data && res.data.status === 3) {
            throw new Error('转存任务失败，请检查网盘空间或文件权限');
        }

        if ((i + 1) % 5 === 0) {
            gopeed.logger.debug(`轮询中... (${i + 1}/${MAX_POLLS})`);
        }
    }

    throw new Error('转存任务超时（30秒），请稍后重试');
}

/**
 * 获取下载链接
 * @param {Array} fids - 文件 ID 列表
 * @returns {Promise<Array>}
 */
async function apiGetDownloadLink(fids) {
    const url = 'https://drive.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=';
    const data = { fids };

    const res = await requestApi(url, 'POST', data);

    if (res.code === 23018) {
        throw new Error('触发 23018 大文件限制错误。本扩展已使用特殊 User-Agent 绕过此限制，如果仍出现此错误，可能是夸克更新了策略。');
    }

    if (res.code !== 0) {
        throw new Error(`${res.message || '获取下载链接失败'}（错误码: ${res.code}）`);
    }

    return res.data || [];
}

/**
 * 递归获取文件夹下的所有文件
 * @param {string} pwdId - 分享 ID
 * @param {string} stoken - 分享 Token
 * @param {string} pdirFid - 父文件夹 ID
 * @param {string} parentPath - 父路径
 * @returns {Promise<Array>}
 */
async function getAllFiles(pwdId, stoken, pdirFid = '', parentPath = '') {
    const detail = await apiGetDetail(pwdId, stoken, pdirFid);
    const list = detail.list || [];

    let allFiles = [];

    for (const item of list) {
        const currentPath = parentPath ? `${parentPath}/${item.file_name}` : item.file_name;

        if (item.dir) {
            // 如果是文件夹，递归获取
            gopeed.logger.info(`进入文件夹: ${currentPath}`);
            const subFiles = await getAllFiles(pwdId, stoken, item.fid, currentPath);
            allFiles = allFiles.concat(subFiles);
        } else {
            // 如果是文件，添加到列表
            gopeed.logger.debug(`找到文件: ${currentPath} (${(item.size / 1024 / 1024).toFixed(2)} MB)`);
            allFiles.push({
                ...item,
                path: parentPath
            });
        }
    }

    return allFiles;
}

/**
 * 主解析函数
 * Gopeed 调用此函数解析夸克网盘分享链接
 */
gopeed.events.onResolve(async (ctx) => {
    const startTime = Date.now();

    try {
        gopeed.logger.info(`========== 开始解析夸克分享 ==========`);
        gopeed.logger.info(`URL: ${ctx.req.url}`);

        // 检查 Cookie 配置
        if (!gopeed.settings.cookie) {
            throw new Error('未配置 Cookie，请在扩展设置中配置夸克 Cookie');
        }

        // 解析 URL
        const { pwdId, passcode } = parseShareUrl(ctx.req.url);

        gopeed.logger.info(`解析结果 - pwdId: ${pwdId}, 密码: ${passcode || '无'}`);

        // 获取 Token
        gopeed.logger.info('Step 1/5: 获取分享 Token...');
        const tokenData = await apiGetToken(pwdId, passcode);
        const stoken = tokenData.stoken;
        const shareTitle = tokenData.title || '夸克分享';
        gopeed.logger.info(`Token 获取成功: ${shareTitle}`);

        // 递归获取所有文件
        gopeed.logger.info('Step 2/5: 扫描文件列表...');
        const allFiles = await getAllFiles(pwdId, stoken);

        if (allFiles.length === 0) {
            throw new Error('分享中没有文件');
        }

        const totalSize = allFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        gopeed.logger.info(`找到 ${allFiles.length} 个文件，总大小: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);

        // 准备转存参数
        const fidList = allFiles.map(f => f.fid);
        const fidTokenList = allFiles.map(f => f.share_fid_token || f.fid_token);

        // 转存文件
        gopeed.logger.info('Step 3/5: 转存文件到网盘...');
        const taskId = await apiSaveFile(pwdId, stoken, fidList, fidTokenList);

        if (!taskId) {
            throw new Error('转存任务创建失败');
        }

        gopeed.logger.info(`Step 4/5: 转存任务创建成功 (${taskId})，等待完成...`);

        // 等待转存完成
        const savedFids = await apiPollTask(taskId);

        if (savedFids.length === 0) {
            throw new Error('转存完成但结果为空');
        }

        // 获取下载链接
        gopeed.logger.info('Step 5/5: 获取下载链接...');
        const downloadData = await apiGetDownloadLink(savedFids);

        if (downloadData.length === 0) {
            throw new Error('获取下载链接失败，请稍后重试');
        }

        gopeed.logger.info(`成功获取 ${downloadData.length} 个下载链接`);

        // 构建返回结果
        ctx.res = {
            name: shareTitle,
            files: downloadData.map((item, index) => {
                const originalFile = allFiles[index] || {};
                return {
                    name: item.file_name,
                    size: item.size,
                    path: originalFile.path || '',
                    req: {
                        url: item.download_url,
                        extra: {
                            header: {
                                'User-Agent': USER_AGENT,
                                'Cookie': gopeed.settings.cookie
                            }
                        }
                    }
                };
            })
        };

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        gopeed.logger.info(`========== 解析完成！耗时: ${elapsed}秒 ==========`);

    } catch (error) {
        gopeed.logger.error(`========== 解析失败: ${error.message} ==========`);
        throw error;
    }
});
