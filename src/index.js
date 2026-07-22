/**
 * Gopeed 夸克网盘解析扩展
 * @version 1.0.4
 * @author muyan556
 */

import superagent from 'superagent';

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const API_BASE_URL = "https://pan.quark.cn";
const DRIVE_BASE_URL = "https://drive-pc.quark.cn";
const MAX_RETRY = 3;
const RETRY_DELAY = 1500;
const PAGE_SIZE = 100;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 工具函数

function parseShareUrl(url) {
    if (!url || typeof url !== 'string') throw new Error('无效的分享链接');
    const clean = url.replace(/\[.*?\]/g, '').trim();
    let pwdId = '', passcode = '', pdirFid = '';

    const idMatch = clean.match(/\/s\/([a-zA-Z0-9]+)/);
    if (idMatch && idMatch[1]) pwdId = idMatch[1];
    else if (clean.length > 10 && clean.match(/^[a-zA-Z0-9]+$/)) pwdId = clean;

    const pwMatch = clean.match(/[?&](pwd|password|pw)=([a-zA-Z0-9]{4})/i);
    if (pwMatch && pwMatch[2]) passcode = pwMatch[2];

    const dirMatch = clean.match(/#\/list\/share\/([a-zA-Z0-9]+)/);
    if (dirMatch && dirMatch[1]) pdirFid = dirMatch[1];

    if (!pwdId) throw new Error('无法从链接中解析出分享 ID');
    return { pwdId, passcode, pdirFid };
}

// Cookie 管理

function getCookie() {
    return gopeed.storage.get('quark_cookie') || gopeed.settings.cookie;
}

function updateCookie(newCookie) {
    gopeed.storage.set('quark_cookie', newCookie);
    gopeed.logger.debug(`Cookie 已更新`);
}

// 网络请求 (使用 superagent)

async function requestApi(url, method, data = {}, retryCount = 0) {
    const cookie = getCookie();
    if (!cookie) throw new Error('未配置 Cookie，请在扩展设置中填入');

    try {
        let req;
        if (method === 'POST') {
            req = superagent.post(url).send(data);
        } else {
            req = superagent.get(url);
        }

        const response = await req
            .set({
                'Cookie': cookie,
                'User-Agent': USER_AGENT,
                'Referer': `${API_BASE_URL}/`,
                'Origin': API_BASE_URL,
                'Content-Type': 'application/json;charset=UTF-8'
            })
            .ok(res => true);  // 接受所有状态码，手动处理错误

        // __puus 刷新机制 (superagent 可以获取 set-cookie 头)
        updatePuusFromResponse(response);

        // 手动检查 HTTP 状态
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = response.body;

        if (result.code === 40001 || result.code === 10000) {
            throw new Error(`Cookie 已失效或登录过期，请重新获取 (代码: ${result.code})`);
        }
        return result;
    } catch (error) {
        if (error.message.includes('Cookie 已失效')) throw error;
        if (retryCount < MAX_RETRY) {
            await sleep(RETRY_DELAY);
            return requestApi(url, method, data, retryCount + 1);
        }
        throw new Error(`网络请求失败: ${error.message}`);
    }
}

// 从响应头中提取并更新 __puus
function updatePuusFromResponse(response) {
    try {
        // superagent 可以访问 set-cookie 头
        const setCookies = Array.isArray(response.headers['set-cookie'])
            ? response.headers['set-cookie']
            : [response.headers['set-cookie']].filter(Boolean);

        const puusCookie = setCookies.find(c => c && c.startsWith('__puus'));

        if (puusCookie) {
            // 提取 __puus=value 部分 (去掉 ; 后面的属性)
            const puusPart = puusCookie.split(';')[0];
            if (puusPart) {
                const currentCookie = getCookie() || '';
                const cookieParts = currentCookie.split(';').map(s => s.trim());
                const puusIndex = cookieParts.findIndex(c => c.startsWith('__puus='));

                if (puusIndex >= 0) {
                    cookieParts[puusIndex] = puusPart;
                } else {
                    cookieParts.push(puusPart);
                }

                const newCookie = cookieParts.join('; ');
                updateCookie(newCookie);
                gopeed.logger.debug(`__puus 已自动刷新`);
            }
        }
    } catch (e) {
        // 静默失败
    }
}

// 夸克 API

async function apiGetToken(pwdId, passcode) {
    const url = `${API_BASE_URL}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&__dt=${Date.now()}`;
    const res = await requestApi(url, 'POST', { pwd_id: pwdId, passcode: passcode || '' });
    if (res.code !== 0) {
        if (res.code === 31001) throw new Error('此分享需要提取码，请在链接末尾加上 ?pwd=密码');
        if (res.code === 31002) throw new Error('分享链接已失效或被取消');
        throw new Error(`获取 Token 失败: ${res.message} (${res.code})`);
    }
    return res.data;
}

async function apiGetDetail(pwdId, stoken, pdirFid = '', page = 1) {
    const url = `${API_BASE_URL}/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${pdirFid}&_page=${page}&_size=${PAGE_SIZE}&_sort=file_type:asc,updated_at:desc&__dt=${Date.now()}`;
    const res = await requestApi(url, 'GET');
    if (res.code !== 0) throw new Error(`获取文件列表失败: ${res.message}`);
    return {
        list: res.data?.list || [],
        _count: res.metadata?._count || 0,
        _total: res.metadata?._total || 0
    };
}

async function apiGetAllDetail(pwdId, stoken, pdirFid = '') {
    let allFiles = [];
    let page = 1;
    
    while (true) {
        const result = await apiGetDetail(pwdId, stoken, pdirFid, page);
        allFiles = allFiles.concat(result.list);
        
        if (result._count < PAGE_SIZE) break;
        
        page++;
        gopeed.logger.debug(`正在获取第 ${page} 页...`);
    }
    
    return { list: allFiles };
}

async function apiSaveFile(pwdId, stoken, fidList, fidTokenList) {
    const url = `${DRIVE_BASE_URL}/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc`;
    const res = await requestApi(url, 'POST', {
        fid_list: fidList, fid_token_list: fidTokenList,
        to_pdir_fid: "0", pwd_id: pwdId, stoken, pdir_fid: "0", scene: "link"
    });
    if (res.code !== 0) throw new Error(`转存失败 (代码:${res.code}): ${res.message}`);
    
    // 如果 API 同步返回了转存结果，直接取出 savedFids
    const syncFids = res.data?.task_resp?.data?.save_as?.save_as_top_fids;
    if (res.data?.task_sync && Array.isArray(syncFids) && syncFids.length > 0) {
        return { taskId: res.data.task_id, savedFids: syncFids };
    }
    return { taskId: res.data?.task_id };
}

async function apiPollTask(taskId, fileCount = 1) {
    const maxPollTimes = Math.min(300, 30 + fileCount);
    let pollCount = 0;
    gopeed.logger.info(`[任务 ${taskId}] 云端转存排队中...`);

    while (pollCount < maxPollTimes) {
        await sleep(1000);
        pollCount++;
        if (pollCount % 10 === 0) {
            gopeed.logger.info(`[任务 ${taskId}] 处理中... 已等待 ${pollCount} 秒`);
        }

        const url = `${DRIVE_BASE_URL}/1/clouddrive/task?pr=ucpro&fr=pc&task_id=${taskId}&__dt=${Date.now()}`;
        const res = await requestApi(url, 'GET');

        if (res.data?.status === 2 || res.data?.status === 1) {
            const fids = res.data.save_as?.save_as_top_fids || res.data.save_as?.save_as_select_top_fids;
            if (Array.isArray(fids) && fids.length > 0) {
                return fids;
            }
            if (res.data?.status === 2) return [];
        }
        if (res.data?.status === 3) throw new Error(`转存失败，云端空间满或风控触发`);
    }
    throw new Error(`转存超时`);
}

async function apiGetDownloadLink(fids) {
    if (!fids || fids.length === 0) return [];
    const BATCH_SIZE = 50;
    let allLinks = [];

    for (let i = 0; i < fids.length; i += BATCH_SIZE) {
        const chunk = fids.slice(i, i + BATCH_SIZE);
        const url = `${DRIVE_BASE_URL}/1/clouddrive/file/download?pr=ucpro&fr=pc`;
        const res = await requestApi(url, 'POST', { fids: chunk });
        if (res.code === 23018) throw new Error('触发夸克限制(23018)，账号可能被风控');
        if (res.code !== 0) throw new Error(`获取直链失败: ${res.message}`);
        if (Array.isArray(res.data)) {
            allLinks = allLinks.concat(res.data);
        }
    }
    return allLinks;
}

async function apiDeleteFile(fids) {
    const url = `${DRIVE_BASE_URL}/1/clouddrive/file/delete?pr=ucpro&fr=pc`;
    try {
        await requestApi(url, 'POST', { action_type: 2, filelist: fids, exclude_fids: [] });
    } catch (e) {
        gopeed.logger.warn(`清理失败 (忽略): ${e.message}`);
    }
}

async function apiGetCapacity() {
    const url = `${DRIVE_BASE_URL}/1/clouddrive/member?pr=ucpro&fr=pc&fetch_subscribe=true&fetch_identity=true`;
    try {
        const res = await requestApi(url, 'GET');
        if (res?.data?.total_capacity !== undefined && res?.data?.use_capacity !== undefined) {
            return Math.max(0, res.data.total_capacity - res.data.use_capacity);
        }
        return -1;
    } catch (e) {
        return -1;
    }
}

// 业务逻辑

async function getAllFiles(pwdId, stoken, pdirFid = '', parentPath = '', maxCount = 0, currentCount = { value: 0 }) {
    const detail = await apiGetAllDetail(pwdId, stoken, pdirFid);
    let allFiles = [];

    for (const item of (detail.list || [])) {
        if (maxCount > 0 && currentCount.value >= maxCount) {
            gopeed.logger.info(`已达到最大文件数量限制 (${maxCount})，停止扫描`);
            break;
        }

        const currentPath = parentPath ? `${parentPath}/${item.file_name}` : item.file_name;
        
        if (item.dir) {
            gopeed.logger.debug(`扫描文件夹: ${currentPath}`);
            const subFiles = await getAllFiles(pwdId, stoken, item.fid, currentPath, maxCount, currentCount);
            allFiles = allFiles.concat(subFiles);
        } else {
            allFiles.push({ ...item, path: parentPath });
            currentCount.value++;
        }
    }
    return allFiles;
}

async function processSmartChunks(pwdId, stoken, allFiles, availableSpace, shouldDelete) {
    const finalParsedFiles = [];
    let chunks = [];
    let skippedCount = 0;

    allFiles.sort((a, b) => (a.size || 0) - (b.size || 0));
    const safeBuffer = 100 * 1024 * 1024;
    const maxChunkSize = availableSpace !== -1 ? Math.max(0, availableSpace - safeBuffer) : Infinity;

    let validFiles = [];
    for (const file of allFiles) {
        if (availableSpace !== -1 && file.size > maxChunkSize) {
            skippedCount++;
        } else {
            validFiles.push(file);
        }
    }

    if (validFiles.length === 0) {
        throw new Error(`网盘空间严重不足 (可用: ${(availableSpace / 1073741824).toFixed(2)}GB)，最小的一个文件也无法转存！`);
    }

    let currentChunk = [];
    let currentChunkSize = 0;
    let totalAccumulatedSize = 0;

    for (const file of validFiles) {
        if (!shouldDelete && availableSpace !== -1 && (totalAccumulatedSize + file.size > maxChunkSize)) {
            skippedCount++;
            continue;
        }
        if (currentChunkSize + file.size > maxChunkSize && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChunkSize = 0;
        }
        currentChunk.push(file);
        currentChunkSize += file.size;
        totalAccumulatedSize += file.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    gopeed.logger.info(`[策略] 共提交 ${allFiles.length - skippedCount} 个文件，切割为 ${chunks.length} 批次轮转。边存边删模式: ${shouldDelete ? '已开启' : '未开启'}`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        gopeed.logger.info(`[进度] 正在处理第 ${i + 1}/${chunks.length} 批次 (包含 ${chunk.length} 个文件)...`);

        const fids = chunk.map(f => f.fid);
        const tokens = chunk.map(f => f.share_fid_token || f.fid_token);

        try {
            const saveRes = await apiSaveFile(pwdId, stoken, fids, tokens);
            const savedFids = (saveRes.savedFids && saveRes.savedFids.length > 0)
                ? saveRes.savedFids
                : await apiPollTask(saveRes.taskId, chunk.length);

            if (savedFids.length > 0) {
                const downloadData = await apiGetDownloadLink(savedFids);
                const usedMap = new Set();

                downloadData.forEach(dLink => {
                    let matchIdx = chunk.findIndex((orig, idx) =>
                        !usedMap.has(idx) && orig.size === dLink.size &&
                        (dLink.file_name.includes(orig.file_name.replace(/\.[^/.]+$/, "")) || orig.file_name === dLink.file_name)
                    );
                    if (matchIdx === -1) matchIdx = chunk.findIndex((o, idx) => !usedMap.has(idx) && o.size === dLink.size);
                    if (matchIdx === -1) matchIdx = chunk.findIndex((o, idx) => !usedMap.has(idx));

                    if (matchIdx !== -1) {
                        usedMap.add(matchIdx);
                        const orig = chunk[matchIdx];
                        finalParsedFiles.push({
                            name: orig.file_name,
                            size: dLink.size,
                            path: orig.path || '',
                            url: dLink.download_url,
                            fid: savedFids[matchIdx] || orig.fid,
                        });
                    }
                });

                if (shouldDelete) {
                    gopeed.logger.info(`[清理] 正在释放第 ${i + 1} 批次占据的网盘空间...`);
                    await apiDeleteFile(savedFids);
                }
            }
        } catch (e) {
            gopeed.logger.error(`[警告] 第 ${i + 1} 批转存失败跳过: ${e.message}`);
        }
    }

    return { finalParsedFiles, skippedCount };
}

// onResolve 事件

gopeed.events.onResolve(async (ctx) => {
    try {
        gopeed.logger.info("=== 夸克网盘解析开始 ===");

        const settingsCookie = (gopeed.settings.cookie || '').trim();
        if (!settingsCookie) throw new Error('未配置 Cookie，请在扩展设置中填入');
        
        const lastSettingsCookie = gopeed.storage.get('last_settings_cookie');
        if (!gopeed.storage.get('quark_cookie') || settingsCookie !== lastSettingsCookie) {
            gopeed.storage.set('quark_cookie', settingsCookie);
            gopeed.storage.set('last_settings_cookie', settingsCookie);
            gopeed.logger.debug("已同步最新 Cookie 到扩展存储");
        }

        const { pwdId, passcode, pdirFid } = parseShareUrl(ctx.req.url);

        gopeed.logger.info("1. 正在获取分享信息...");
        const tokenData = await apiGetToken(pwdId, passcode);
        const shareTitle = tokenData.title || 'Quark_Download';

        gopeed.logger.info("2. 正在递归扫描文件夹结构...");
        const maxFileCount = parseInt(gopeed.settings.max_file_count) || 0;
        if (maxFileCount > 0) {
            gopeed.logger.info(`--> 最大文件数量限制: ${maxFileCount}`);
        }
        
        const allFiles = await getAllFiles(pwdId, tokenData.stoken, pdirFid, '', maxFileCount);
        if (allFiles.length === 0) throw new Error('此分享链接中没有找到文件');

        const totalSize = allFiles.reduce((s, f) => s + (f.size || 0), 0);
        gopeed.logger.info(`--> 扫描完毕: 共 ${allFiles.length} 个文件，总计 ${(totalSize / 1073741824).toFixed(2)} GB`);

        gopeed.logger.info("3. 检查网盘空间，制定转存策略...");
        const availableSpace = await apiGetCapacity();
        if (availableSpace >= 0) {
            gopeed.logger.info(`--> 当前网盘单次可用承载空间: ${(availableSpace / 1073741824).toFixed(2)} GB`);
        } else {
            gopeed.logger.info(`--> 获取容量失败，将执行盲转策略`);
        }

        const shouldDelete = gopeed.settings.delete_file === "1";

        gopeed.logger.info("4. 开始轮转提取下载直链...");
        const { finalParsedFiles, skippedCount } = await processSmartChunks(pwdId, tokenData.stoken, allFiles, availableSpace, shouldDelete);

        if (finalParsedFiles.length === 0) {
            throw new Error(`提取失败，转存任务未生成有效直链。可能原因：网盘空间不足、分享链接已失效、或 API 调用失败。请检查：
- 分享链接是否还能正常查看文件
- Cookie 是否完整有效（建议重新在浏览器复制）
- 文件大小是否超过当前网盘可用空间（扩展会自动跳过超大文件）`);
        }
        gopeed.logger.info(`=== 解析成功! 本次有效获取: ${finalParsedFiles.length}/${allFiles.length} 个文件直链 ===`);

        let finalTitle = shareTitle;
        if (skippedCount > 0) {
            finalTitle += ` (因空间满已跳过${skippedCount}个大文件)`;
            gopeed.logger.warn(`存在 ${skippedCount} 个文件因自身大小超过了网盘可用空间，无法处理。`);
        }

        ctx.res = {
            name: finalTitle,
            files: finalParsedFiles.map(item => ({
                name: item.name,
                size: item.size,
                path: item.path,
                req: {
                    url: item.url,
                    labels: {
                        type: 'quark',
                        fid: item.fid,
                    },
                    extra: {
                        header: {
                            'User-Agent': USER_AGENT,
                            'Cookie': getCookie(),
                            'Referer': 'https://pan.quark.cn/'
                        }
                    }
                }
            }))
        };

    } catch (error) {
        gopeed.logger.error(`致命错误: ${error.message}`);
        throw new MessageError(error.message);
    }
});

// onStart 事件

gopeed.events.onStart(async (ctx) => {
    const { req } = ctx.task.meta;
    const labels = req.labels;
    const downloadUrl = req.url;

    gopeed.logger.debug(`任务开始，检查下载链接是否过期...`);

    try {
        const isExpired = await checkLinkExpire(downloadUrl, req.extra?.header);

        if (isExpired && labels?.fid) {
            gopeed.logger.debug(`下载链接已过期，正在获取新链接...`);
            const result = await apiGetDownloadLink([labels.fid]);
            if (result && result[0]?.download_url) {
                req.url = result[0].download_url;
                gopeed.logger.debug(`成功获取新的下载链接`);
            } else {
                throw new Error('获取新链接失败');
            }
        } else {
            gopeed.logger.debug(`下载链接仍然有效`);
        }
    } catch (error) {
        gopeed.logger.error(`下载链接刷新失败: ${error.message}`);
    }
});

async function checkLinkExpire(url, headers = {}) {
    try {
        const query = new URL(url).searchParams;
        const expires = query.get('Expires');
        if (expires && Date.now() < new Date(parseInt(expires) * 1000)) {
            const { status } = await fetch(url, {
                method: 'GET',
                headers: { 'Range': 'bytes=0-0', ...headers }
            });
            return status < 200 || status >= 400;
        }
    } catch (error) {
        gopeed.logger.warn(`检查链接有效期时发生错误: ${error.message}`);
    }
    return true;
}
