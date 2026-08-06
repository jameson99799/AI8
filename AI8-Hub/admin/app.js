const state = {
    adminToken: window.localStorage.getItem("ai8_admin_token") || "",
    config: null,
    runtime: null,
    channels: [],
    models: []
};

const DEFAULT_ADMIN_TOKEN = "ai8-admin-local";

// Build version tag (from app.js?v=N query or default)
const buildVersionTag = document.getElementById('buildVersionTag');
if (buildVersionTag) {
    const src = (document.currentScript && document.currentScript.src) || "";
    const m = src.match(/[?&]v=(\d+)/);
    buildVersionTag.textContent = "BUILD v" + (m ? m[1] : "?");
}

// DOM Elements
const elements = {
    loginOverlay: document.getElementById("loginOverlay"),
    appLayout: document.getElementById("appLayout"),
    loginForm: document.getElementById("loginForm"),
    adminTokenInput: document.getElementById("adminTokenInput"),
    statusBanner: document.getElementById("statusBanner"),
    logoutButton: document.getElementById("logoutButton"),
    
    // Config Elements
    configForm: document.getElementById("configForm"),
    saveConfigButton: document.getElementById("saveConfigButton"),
    adminTokenConfig: document.getElementById("adminTokenConfig"),
    ai8BaseUrl: document.getElementById("ai8BaseUrl"),
    ai8AuthToken: document.getElementById("ai8AuthToken"),
    ai8DefaultModel: document.getElementById("ai8DefaultModel"),
    ai8RequestTimeoutMs: document.getElementById("ai8RequestTimeoutMs"),
    ai8DeleteSessionAfterResponse: document.getElementById("ai8DeleteSessionAfterResponse"),
    apiKeys: document.getElementById("apiKeys"),
    gptallEnabled: document.getElementById("gptallEnabled"),
    gptallBaseUrl: document.getElementById("gptallBaseUrl"),
    gptallAuthToken: document.getElementById("gptallAuthToken"),
    gptallCookie: document.getElementById("gptallCookie"),
    gptallFingerprint: document.getElementById("gptallFingerprint"),
    gptallDefaultModel: document.getElementById("gptallDefaultModel"),
    gptallAllowedModels: document.getElementById("gptallAllowedModels"),
    gptallRequestTimeoutMs: document.getElementById("gptallRequestTimeoutMs"),
    
    // Import / Export
    exportConfigBtn: document.getElementById("exportConfigBtn"),
    importConfigBtn: document.getElementById("importConfigBtn"),
    importFileInput: document.getElementById("importFileInput"),
    
    // Overview Elements
    runtimeGrid: document.getElementById("runtimeGrid"),
    exampleOutput: document.getElementById("exampleOutput"),
    
    // Models & Logs
    modelsMeta: document.getElementById("modelsMeta"),
    modelsList: document.getElementById("modelsList"),
    refreshModelsButton: document.getElementById("refreshModelsButton"),
    logsOutput: document.getElementById("logsOutput"),
    refreshLogsButton: document.getElementById("refreshLogsButton"),
    
    // Channels
    channelsList: document.getElementById("channelsList"),
    btnAddChannel: document.getElementById("btnAddChannel"),
    channelModal: document.getElementById("channelModal"),
    channelForm: document.getElementById("channelForm"),
    btnCancelChannel: document.getElementById("btnCancelChannel"),
    toggleApiKeyVisibility: document.getElementById("toggleApiKeyVisibility"),
    
    navItems: document.querySelectorAll('.nav-item'),
    tabPanes: document.querySelectorAll('.tab-pane')
};

wireEvents();
bootstrap();

function wireEvents() {
    // Auth
    elements.loginForm.addEventListener("submit", async event => {
        event.preventDefault();
        state.adminToken = elements.adminTokenInput.value.trim();
        window.localStorage.setItem("ai8_admin_token", state.adminToken);
        await loadConsole();
    });

    elements.logoutButton.addEventListener("click", () => {
        state.adminToken = "";
        state.config = null;
        state.runtime = null;
        window.localStorage.removeItem("ai8_admin_token");
        elements.adminTokenInput.value = "";
        setStatus("已退出", "success");
        showLogin();
    });

    // Config
    elements.saveConfigButton.addEventListener("click", async () => {
        await saveGlobalConfig();
    });

    // Import / Export
    elements.exportConfigBtn.addEventListener("click", async () => {
        try {
            const raw = await requestJson("/admin/api/export");
            const blob = new Blob([JSON.stringify(raw, null, 2)], {type: "application/json"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `ai8-hub-config-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch(e) {
            alert("导出失败: " + e.message);
        }
    });
    
    elements.importConfigBtn.addEventListener("click", () => {
        elements.importFileInput.click();
    });
    
    elements.importFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const parsed = JSON.parse(event.target.result);
                if (!confirm("确定要导入这组配置吗？这会覆盖所有的渠道和本地设置。")) return;
                await requestJson("/admin/api/import", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(parsed)
                });
                alert("导入成功！设置已立即生效。");
                await loadConsole();
            } catch(error) {
                alert("导入失败、可能不是规范的 JSON 文件: " + error.message);
            }
            elements.importFileInput.value = ""; // reset
        };
        reader.readAsText(file);
    });

    // Models & Logs
    elements.refreshModelsButton.addEventListener("click", async () => {
        await fetchModels(true);
    });
    elements.refreshLogsButton.addEventListener("click", async () => {
        await loadLogs();
    });

    // Navigation Tabs
    elements.navItems.forEach(nav => {
        nav.addEventListener('click', e => {
            e.preventDefault();
            const tabId = nav.getAttribute('data-tab');
            switchTab(tabId);
        });
    });
    
    // Channels
    elements.btnAddChannel.addEventListener("click", () => openChannelModal());
    elements.btnCancelChannel.addEventListener("click", () => elements.channelModal.classList.remove('active'));
    
    elements.toggleApiKeyVisibility.addEventListener("click", () => {
        const input = document.getElementById("channelApiKey");
        if (input.type === "password") {
            input.type = "text";
            elements.toggleApiKeyVisibility.textContent = "🙈";
        } else {
            input.type = "password";
            elements.toggleApiKeyVisibility.textContent = "👁️";
        }
    });
    
    elements.channelForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await saveChannel();
    });
    
    // Test logic
    document.getElementById("btnRunTest").addEventListener("click", runModelTest);
}

function switchTab(tabId) {
    elements.navItems.forEach(nav => nav.classList.remove('active'));
    elements.tabPanes.forEach(pane => pane.classList.remove('active'));
    
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
}

async function bootstrap() {
    if (!state.adminToken) {
        state.adminToken = DEFAULT_ADMIN_TOKEN;
    }

    elements.adminTokenInput.value = state.adminToken;
    if (state.adminToken) {
        let valid = await loadConsole();
        if(!valid && state.adminToken === DEFAULT_ADMIN_TOKEN) {
            state.adminToken = ""; 
            window.localStorage.removeItem("ai8_admin_token");
            elements.adminTokenInput.value = "";
        }
    } else {
        showLogin();
    }
}

function showLogin() {
    elements.appLayout.style.display = "none";
    elements.loginOverlay.classList.add("active");
}

function showApp() {
    elements.loginOverlay.classList.remove("active");
    elements.appLayout.style.display = "flex";
}

async function loadConsole() {
    if (!state.adminToken) {
        setStatus("请先输入后台令牌。", "error");
        return false;
    }

    setStatus("正在加载核心...");

    try {
        const [runtime, configUrlRes] = await Promise.all([
            requestJson("/admin/api/runtime"),
            requestJson("/admin/api/config"),
        ]);

        state.runtime = runtime;
        state.config = configUrlRes.config || null;

        renderRuntime(runtime);
        renderConfig(configUrlRes.config || {});
        renderExample();
        
        showApp();

        await Promise.allSettled([
            fetchModels(false), // Fetch models into state.models
            loadChannels(),
            loadLogs()
        ]);

        setStatus("", "");
        return true;
    } catch (error) {
        setStatus(error.message, "error");
        showLogin();
        return false;
    }
}

// ----- Config -----
async function saveGlobalConfig() {
    try {
        const originalText = elements.saveConfigButton.textContent;
        elements.saveConfigButton.textContent = "保存中...";
        const payload = {
            adminToken: elements.adminTokenConfig.value.trim(),
            ai8AuthToken: elements.ai8AuthToken.value.trim(),
            ai8BaseUrl: elements.ai8BaseUrl.value.trim(),
            ai8DefaultModel: elements.ai8DefaultModel.value.trim(),
            ai8RequestTimeoutMs: toNumberString(elements.ai8RequestTimeoutMs.value),
            ai8DeleteSessionAfterResponse: elements.ai8DeleteSessionAfterResponse.value === "true",
            apiKeys: elements.apiKeys.value.trim(),
            gptallEnabled: elements.gptallEnabled.value === "true",
            gptallBaseUrl: elements.gptallBaseUrl.value.trim(),
            gptallAuthToken: elements.gptallAuthToken.value.trim(),
            gptallCookie: elements.gptallCookie.value.trim(),
            gptallFingerprint: elements.gptallFingerprint.value.trim(),
            gptallDefaultModel: elements.gptallDefaultModel.value.trim(),
            gptallAllowedModels: elements.gptallAllowedModels.value.trim(),
            gptallRequestTimeoutMs: toNumberString(elements.gptallRequestTimeoutMs.value),
        };

        const response = await requestJson("/admin/api/config", {
            body: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
        });

        state.config = response.config || payload;
        renderConfig(state.config);
        
        elements.saveConfigButton.textContent = "保存成功";
        setTimeout(()=> elements.saveConfigButton.textContent = originalText, 2000);

        if (!response.token_still_valid) {
            alert("配置已保存，但当前后台令牌已失效，请使用新的后台令牌重新登录。");
            elements.logoutButton.click();
        }
    } catch (error) {
        alert(error.message);
        elements.saveConfigButton.textContent = "保存配置";
    }
}

// ----- Channels -----
async function loadChannels() {
    try {
        const res = await requestJson("/admin/api/channels");
        state.channels = res.data || [];
        renderChannelsList();
    } catch (e) {
        console.error(e);
    }
}

function renderChannelsList() {
    elements.channelsList.innerHTML = "";
    
    // Virtual Channel for Original AI8 Backend
    const ai8ChannelHTML = `
        <div class="channel-row">
            <div class="channel-row-header" onclick="toggleAccordion(this)">
                <div class="channel-info-short">
                    <div class="channel-icon">⚡</div>
                    <div class="stack" style="gap:2px;">
                        <div class="channel-title">系统直连模型资源区 (原生 AI8)</div>
                        <div class="channel-badge">集成默认接口</div>
                    </div>
                </div>
                <div class="channel-status ${state.config.ai8Enabled !== false ? 'active' : ''}" onclick="toggleAi8(event, this)"></div>
            </div>
            <div class="channel-body">
                <div class="channel-detail-grid">
                    <div><strong>API 地址:</strong> ${escapeHtml(state.config.ai8BaseUrl || "-")}</div>
                    <div><strong>API 凭证:</strong> <span style="filter: blur(4px); cursor:pointer;" onclick="this.style.filter='none'">${escapeHtml(state.config.ai8AuthToken || "未配置")}</span></div>
                </div>
                <div class="channel-actions flex-between" style="gap:10px;">
                    <button class="ghost-button" style="flex:1" onclick="openChannelModelsModal('ai8')" type="button">管理查看内置模型</button>
                    <!-- Settings for AI8 are handled via global Config logic but mapped here visually -->
                </div>
            </div>
        </div>
    `;
    elements.channelsList.insertAdjacentHTML('beforeend', ai8ChannelHTML);

    // Virtual Channel for Native gpt-all Backend
    const gptallEnabled = state.config.gptallEnabled === true;
    const gptallChannelHTML = `
        <div class="channel-row">
            <div class="channel-row-header" onclick="toggleAccordion(this)">
                <div class="channel-info-short">
                    <div class="channel-icon">🚀</div>
                    <div class="stack" style="gap:2px;">
                        <div class="channel-title">gpt-all 独立渠道 (原生 gpt-all)</div>
                        <div class="channel-badge">独立原生接口</div>
                    </div>
                </div>
                <div class="channel-status ${gptallEnabled ? 'active' : ''}" onclick="toggleGptAll(event, this)"></div>
            </div>
            <div class="channel-body">
                <div class="channel-detail-grid">
                    <div><strong>API 地址:</strong> ${escapeHtml(state.config.gptallBaseUrl || "-")}</div>
                    <div><strong>API 凭证:</strong> <span style="filter: blur(4px); cursor:pointer;" onclick="this.style.filter='none'">${escapeHtml(state.config.gptallAuthToken || "未配置")}</span></div>
                </div>
                <div class="channel-actions flex-between" style="gap:10px;">
                    <button class="ghost-button" style="flex:1" onclick="openChannelModelsModal('gptall')" type="button">管理查看内置模型</button>
                </div>
            </div>
        </div>
    `;
    elements.channelsList.insertAdjacentHTML('beforeend', gptallChannelHTML);
    
    // Custom Channels
    state.channels.forEach((ch, index) => {
        const protoText = ch.protocol === "openai" ? "仅OpenAI" : (ch.protocol === "claude" ? "仅Claude" : "双核(全自适应)");
        const card = document.createElement('div');
        card.className = "channel-row";
        card.innerHTML = `
            <div class="channel-row-header" onclick="toggleAccordion(this)">
                <div class="channel-info-short">
                    <div class="channel-icon">🔗</div>
                    <div class="stack" style="gap:2px;">
                        <div class="channel-title">${escapeHtml(ch.name)}</div>
                        <div class="channel-badge">支持网络通讯格式：${protoText}</div>
                    </div>
                </div>
                <div class="channel-status ${ch.enabled ? 'active' : ''}" onclick="toggleChannel(event, this, ${index})"></div>
            </div>
            <div class="channel-body">
                <div class="channel-detail-grid">
                    <div><strong>API 地址:</strong> ${escapeHtml(ch.baseUrl)}</div>
                    <div><strong>密钥:</strong> <span style="cursor:pointer; filter: blur(4px);" onclick="this.style.filter='none'">${escapeHtml(ch.apiKey)}</span></div>
                </div>
                <div class="channel-actions" style="display:flex; gap: 10px;">
                    <button class="ghost-button" style="flex:2" onclick="openChannelModelsModal(${index})" type="button">查看该渠道模型池</button>
                    <button class="ghost-button" style="flex:1" onclick="editChannel(${index})" type="button">修改参数</button>
                    <button class="danger-button" style="flex:1" onclick="deleteChannel(${index})" type="button">移除资源</button>
                </div>
            </div>
        `;
        elements.channelsList.appendChild(card);
    });
}

window.toggleAccordion = function(el) {
    const row = el.closest(".channel-row");
    row.classList.toggle("expanded");
}

function openChannelModal(index = -1) {
    elements.channelModal.classList.add('active');
    if (index >= 0) {
        const ch = state.channels[index];
        document.getElementById('channelId').value = index;
        document.getElementById('channelName').value = ch.name;
        document.getElementById('channelBaseUrl').value = ch.baseUrl;
        document.getElementById('channelApiKey').value = ch.apiKey;
        document.getElementById('channelProtocol').value = ch.protocol || "both";
        document.getElementById('modalTitle').textContent = "编辑渠道参数";
    } else {
        document.getElementById('channelForm').reset();
        document.getElementById('channelId').value = "";
        document.getElementById('channelProtocol').value = "both";
        document.getElementById('modalTitle').textContent = "新增外部渠道资源";
    }
}
window.editChannel = openChannelModal;

async function saveChannel() {
    const id = document.getElementById('channelId').value;
    const name = document.getElementById('channelName').value.trim();
    const baseUrl = document.getElementById('channelBaseUrl').value.trim();
    const apiKey = document.getElementById('channelApiKey').value.trim();
    const protocol = document.getElementById('channelProtocol').value;
    
    if(!name || !baseUrl) return;
    
    const newChannel = { name, baseUrl, apiKey, protocol, enabled: true };
    
    let updated = [...state.channels];
    if (id !== "" && id >= 0) {
        newChannel.enabled = updated[id].enabled;
        updated[id] = newChannel;
    } else {
        updated.push(newChannel);
    }
    
    await updateChannelsAPI(updated);
    elements.channelModal.classList.remove('active');
}

window.deleteChannel = async function(index) {
    if(!confirm("确定要删除此外部资源配置吗？")) return;
    let updated = [...state.channels];
    updated.splice(index, 1);
    await updateChannelsAPI(updated);
}

window.toggleChannel = async function(event, el, index) {
    event.stopPropagation(); // prevent accordion expansion
    let updated = [...state.channels];
    updated[index].enabled = !updated[index].enabled;
    if(updated[index].enabled) el.classList.add('active');
    else el.classList.remove('active');
    await updateChannelsAPI(updated);
}

window.toggleAi8 = async function(event, el) {
    event.stopPropagation();
    const isEnabled = state.config.ai8Enabled !== false; // Default true
    const newEnabled = !isEnabled;
    if(newEnabled) el.classList.add('active');
    else el.classList.remove('active');

    try {
        const response = await requestJson("/admin/api/config", {
            body: JSON.stringify({ ai8Enabled: newEnabled }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
        });
        state.config = response.config || state.config;
        fetchModels(true);
    } catch (e) {
        alert("保存 AI8 状态配置失败:" + e.message);
    }
}

window.toggleGptAll = async function(event, el) {
    event.stopPropagation();
    const isEnabled = state.config.gptallEnabled === true;
    const newEnabled = !isEnabled;
    if(newEnabled) el.classList.add('active');
    else el.classList.remove('active');

    try {
        const response = await requestJson("/admin/api/config", {
            body: JSON.stringify({ gptallEnabled: newEnabled }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
        });
        state.config = response.config || state.config;
        fetchModels(true);
    } catch (e) {
        alert("保存 gpt-all 状态配置失败:" + e.message);
    }
}

async function updateChannelsAPI(channels) {
    try {
        const res = await requestJson("/admin/api/channels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(channels)
        });
        state.channels = res.data;
        renderChannelsList();
        fetchModels(true); // refresh aggregated pool in backend
    } catch(e) {
        alert("保存参数更新记录失败: " + e.message);
    }
}

// ----- Model Handling & Testing -----
async function fetchModels(forceRefresh) {
    try {
        elements.modelsMeta.textContent = "汇集最新聚合模型中...";
        const suffix = forceRefresh ? "?refresh=true" : "";
        const payload = await requestJson(`/admin/api/models${suffix}`);
        const models = Array.isArray(payload.data) ? payload.data : [];
        state.models = models;
        renderGlobalModels(models);
    } catch (error) {
        elements.modelsMeta.textContent = error.message;
        elements.modelsList.innerHTML = "";
    }
}

function renderGlobalModels(models) {
    const blacklist = getGlobalBlacklist();
    elements.modelsMeta.textContent = `系统共动态拦截提取了 ${models.length} 个模型支持。勾选 = 加入全局黑名单（即时保存），取消勾选 = 自动移出黑名单。`;
    const listEl = elements.modelsList;
    listEl.innerHTML = "";
    if (!models.length) {
        listEl.innerHTML = "<div class='muted'>未获取到任何模型，请先点击「强刷获取模型」。</div>";
        return;
    }
    models.forEach(model => {
        const v = String(model.value || model.origId || "").trim();
        if (!v) return;
        const provider = escapeHtml(model?.attr?.providerName || model.channel || "ai8");
        const checked = blacklist.includes(v) ? "checked" : "";
        const row = document.createElement("label");
        row.className = "checklist-item flex-between";
        row.dataset.searchTarget = v.toLowerCase();
        const display = model.display_value || v;
        row.innerHTML = `
            <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                <input type="checkbox" class="global-model-checkbox" value="${escapeHtml(v)}" ${checked} onchange="toggleGlobalBlacklistModel(this)">
                <span class="checklist-name">${escapeHtml(display)}</span>
                <small style="opacity:0.7; flex-shrink:0;">[${provider}]</small>
            </div>
        `;
        listEl.appendChild(row);
    });
    filterGlobalModels();
}

window.toggleGlobalBlacklistModel = async function(cb) {
    const v = cb.value;
    const current = getGlobalBlacklist();
    if (cb.checked) {
        if (!current.includes(v)) await saveGlobalBlacklist([...current, v], { silent: true });
    } else {
        if (current.includes(v)) await saveGlobalBlacklist(current.filter(x => x !== v), { silent: true });
    }
}

// ----- Global Blacklist Management -----
function getGlobalBlacklist() {
    const raw = (state.config && state.config.blacklistedModels);
    if (Array.isArray(raw)) return raw;
    return String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
}

function visibleBlacklistCheckboxes(containerId, cbClass) {
    return Array.from(document.querySelectorAll(`#${containerId} .checklist-item`))
        .filter(el => el.style.display !== 'none')
        .flatMap(el => Array.from(el.querySelectorAll(cbClass)));
}

function renderBlacklistPanels() {
    const blacklist = getGlobalBlacklist();
    const bl = document.getElementById('blacklistModelsList');
    bl.innerHTML = "";
    if (blacklist.length === 0) {
        bl.innerHTML = "<div class='muted'>黑名单为空。</div>";
    } else {
        blacklist.forEach(v => {
            if (!v) return;
            const row = document.createElement("label");
            row.className = "checklist-item flex-between";
            row.dataset.searchTarget = v.toLowerCase();
            row.innerHTML = `
                <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                    <input type="checkbox" class="bl-list-checkbox" value="${escapeHtml(v)}">
                    <span class="checklist-name">${escapeHtml(v)}</span>
                </div>
            `;
            bl.appendChild(row);
        });
    }
    filterBlacklistList();
}

window.toggleBlacklistPanel = function() {
    const panel = document.getElementById('blacklistPanel');
    const btn = document.getElementById('blacklistToggleButton');
    if (!panel) { console.error("blacklistPanel element not found"); return; }
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    if (btn) btn.classList.toggle('active', !showing);
    if (!showing) renderBlacklistPanels();
}

window.filterBlacklistList = function() {
    const term = document.getElementById('blListSearch').value.toLowerCase().trim();
    const items = document.querySelectorAll('#blacklistModelsList .checklist-item');
    items.forEach(item => { item.style.display = (!term || (item.dataset.searchTarget || '').includes(term)) ? "flex" : "none"; });
}

window.filterGlobalModels = function() {
    const term = document.getElementById('globalModelSearch').value.toLowerCase().trim();
    const items = document.querySelectorAll('#modelsList .checklist-item');
    items.forEach(item => { item.style.display = (!term || (item.dataset.searchTarget || '').includes(term)) ? "flex" : "none"; });
}

window.selectAllGlobalModels = async function() {
    const visible = visibleBlacklistCheckboxes('modelsList', '.global-model-checkbox');
    if (!visible.length) {
        alert("当前没有可勾选的模型。");
        return;
    }
    const current = getGlobalBlacklist();
    const merged = Array.from(new Set([...current, ...visible.map(cb => cb.value)]));
    if (merged.length === current.length) {
        alert("当前显示的模型都已在黑名单中。");
        return;
    }
    await saveGlobalBlacklist(merged);
}

window.deselectAllGlobalModels = async function() {
    const visible = visibleBlacklistCheckboxes('modelsList', '.global-model-checkbox').map(cb => cb.value);
    if (!visible.length) {
        alert("当前没有可取消勾选的模型。");
        return;
    }
    const current = getGlobalBlacklist();
    const remaining = current.filter(v => !visible.includes(v));
    if (remaining.length === current.length) {
        alert("当前显示的模型都不在黑名单中。");
        return;
    }
    await saveGlobalBlacklist(remaining);
}

window.selectAllBlacklistList = function() {
    visibleBlacklistCheckboxes('blacklistModelsList', '.bl-list-checkbox').forEach(cb => cb.checked = true);
}

window.deselectAllBlacklistList = function() {
    visibleBlacklistCheckboxes('blacklistModelsList', '.bl-list-checkbox').forEach(cb => cb.checked = false);
}

async function saveGlobalBlacklist(list, opts) {
    try {
        const response = await requestJson("/admin/api/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ blacklistedModels: list.join(",") })
        });
        state.config = response.config || state.config;
        renderBlacklistPanels();
        renderGlobalModels(state.models);
        if (!(opts && opts.silent)) alert("黑名单已保存，当前共 " + list.length + " 个模型。");
    } catch (e) {
        renderGlobalModels(state.models);
        if (!(opts && opts.silent)) alert("保存黑名单失败: " + e.message);
    }
}

window.removeModelsFromBlacklist = async function() {
    const selected = Array.from(document.querySelectorAll('#blacklistModelsList .bl-list-checkbox:checked')).map(cb => cb.value);
    if (selected.length === 0) {
        alert("请先在上方勾选要移出黑名单的模型。");
        return;
    }
    await saveGlobalBlacklist(getGlobalBlacklist().filter(v => !selected.includes(v)));
}

function getChannelFilteredModels(sourceId, isGptAll) {
    const ch = (sourceId === 'ai8' || isGptAll) ? null : state.channels[sourceId];
    return state.models.filter(m => {
        if (sourceId === 'ai8') return m.channel === 'ai8' || (m.attr && m.attr.providerName === 'ai8') || (m.channel === undefined);
        if (isGptAll) return m._source === 'gptall' || m.channel === 'gpt-all' || (m.attr && m.attr.providerName === 'gpt-all');
        return ch && (m.channel === ch.name || (m.attr && m.attr.providerName === ch.name));
    });
}

function getChannelSelection(sourceId, isGptAll, mode) {
    const parseList = (raw) => {
        if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
        return String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
    };
    if (sourceId === 'ai8') {
        return parseList(mode === 'blacklist' ? state.config.ai8BlacklistedModels : state.config.ai8AllowedModels);
    }
    if (isGptAll) {
        const raw = mode === 'blacklist' ? state.config.gptallBlacklistedModels : state.config.gptallAllowedModels;
        return parseList(raw);
    }
    const ch = state.channels[sourceId];
    if (mode === 'blacklist') {
        return Array.isArray(ch && ch.blacklistedModels) ? ch.blacklistedModels : [];
    }
    return Array.isArray(ch && ch.models) ? ch.models : [];
}

function renderChannelModelChecklist() {
    const sourceId = document.getElementById('modelsModal').dataset.activeSourceId;
    const isGptAll = sourceId === 'gptall';
    const ch = (sourceId === 'ai8' || isGptAll) ? null : state.channels[sourceId];
    const mode = document.getElementById('channelModelsMode').value;
    const meta = document.getElementById('channelModelsMeta');
    if (mode === 'blacklist') {
        meta.textContent = "黑名单模式：勾选的模型将被禁用，通过 API 无法获取；取消勾选即恢复可用。未勾选任何模型 = 全量放通。";
    } else {
        meta.textContent = "白名单模式：勾选的模型才允许使用；未勾选任何模型 = 全量放通渠道内的所有模型。";
    }

    const filteredModels = getChannelFilteredModels(sourceId, isGptAll);
    const clist = document.getElementById('channelModelsList');
    clist.innerHTML = "";
    if (filteredModels.length === 0) {
        clist.innerHTML = "<div class='muted'>该渠道当前未探测到有效的模型映射表，可能被关闭或密钥配错。</div>";
        return;
    }

    const selection = getChannelSelection(sourceId, isGptAll, mode);
    filteredModels.forEach(m => {
        const v = m.origId || m.value; // Display actual origId without suffix for clarity in selection
        const isChecked = selection.includes(v) ? 'checked' : '';
        const row = document.createElement("label");
        row.className = "checklist-item flex-between";
        row.style = "display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer;";
        row.dataset.searchTarget = v.toLowerCase();
        row.innerHTML = `
            <div style="display: flex; gap: 8px; align-items: center;">
                <input type="checkbox" class="channel-model-checkbox" value="${escapeHtml(v)}" ${isChecked}>
                <span style="font-weight: 500;">${escapeHtml(v)}</span>
            </div>
            <button type="button" class="ghost-button" onclick="event.preventDefault(); openTestModal('${escapeHtml(m.display_value || m.value)}')">🧪测试</button>
        `;
        clist.appendChild(row);
    });
    filterChannelModels();
}

window.openChannelModelsModal = function(sourceId) {
    const isGptAll = sourceId === 'gptall';
    const ch = (sourceId === 'ai8' || isGptAll) ? null : state.channels[sourceId];
    const filteredModels = getChannelFilteredModels(sourceId, isGptAll);
    
    let sourceName = sourceId === 'ai8' ? '原生 AI8' : (isGptAll ? '原生 gpt-all' : (ch ? ch.name : "未知渠道"));
    document.getElementById('modelsModalTitle').textContent = `[${escapeHtml(sourceName)}] 专属模型池`;
    
    // Store sourceId globally to use it in Save button
    document.getElementById('modelsModal').dataset.activeSourceId = sourceId;
    document.getElementById('modelSearchInput').value = ""; // clear search
    
    const savedMode = window.localStorage.getItem(`ai8_model_mode_${sourceId}`) || 'whitelist';
    document.getElementById('channelModelsMode').value = savedMode === 'blacklist' ? 'blacklist' : 'whitelist';
    
    renderChannelModelChecklist();
    document.getElementById('modelsModal').classList.add('active');
}

window.onChannelModelsModeChange = function() {
    const sourceId = document.getElementById('modelsModal').dataset.activeSourceId;
    if (!sourceId) return;
    const mode = document.getElementById('channelModelsMode').value;
    window.localStorage.setItem(`ai8_model_mode_${sourceId}`, mode);
    renderChannelModelChecklist();
}

window.filterChannelModels = function() {
    const term = document.getElementById('modelSearchInput').value.toLowerCase().trim();
    const items = document.querySelectorAll('#channelModelsList .checklist-item');
    items.forEach(item => {
        if (!term || item.dataset.searchTarget.includes(term)) {
            item.style.display = "flex";
        } else {
            item.style.display = "none";
        }
    });
}

window.selectAllChannelModels = function() {
    const checkboxes = document.querySelectorAll('#channelModelsList .checklist-item[style*="display: flex"] .channel-model-checkbox, #channelModelsList .checklist-item:not([style*="display: none"]) .channel-model-checkbox');
    checkboxes.forEach(cb => cb.checked = true);
}

window.deselectAllChannelModels = function() {
    const checkboxes = document.querySelectorAll('#channelModelsList .checklist-item[style*="display: flex"] .channel-model-checkbox, #channelModelsList .checklist-item:not([style*="display: none"]) .channel-model-checkbox');
    checkboxes.forEach(cb => cb.checked = false);
}

document.getElementById('btnSaveChannelModels').addEventListener('click', async () => {
    const sourceId = document.getElementById('modelsModal').dataset.activeSourceId;
    const checkboxes = document.querySelectorAll('#channelModelsList .channel-model-checkbox:checked');
    const selectedModels = Array.from(checkboxes).map(cb => cb.value);
    const isGptAll = sourceId === 'gptall';
    
    try {
        const btn = document.getElementById('btnSaveChannelModels');
        const oldText = btn.textContent;
        btn.textContent = "正在同步配置...";
        const mode = document.getElementById('channelModelsMode').value;
        
        if (sourceId === 'ai8') {
            const response = await requestJson("/admin/api/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(mode === 'blacklist'
                    ? { ai8BlacklistedModels: selectedModels.join(",") }
                    : { ai8AllowedModels: selectedModels.join(",") })
            });
            state.config = response.config || state.config;
        } else if (sourceId === 'gptall') {
            const response = await requestJson("/admin/api/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(mode === 'blacklist'
                    ? { gptallBlacklistedModels: selectedModels.join(",") }
                    : { gptallAllowedModels: selectedModels.join(",") })
            });
            state.config = response.config || state.config;
        } else {
            let updated = [...state.channels];
            updated[sourceId][mode === 'blacklist' ? 'blacklistedModels' : 'models'] = selectedModels;
            
            await requestJson("/admin/api/channels", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updated)
            });
            state.channels = updated;
        }
        
        if (mode === 'blacklist') {
            await syncChannelBlacklistToGlobal(sourceId, isGptAll, selectedModels);
        }
        
        btn.textContent = "同步完成！";
        setTimeout(() => {
            btn.textContent = oldText;
            document.getElementById('modelsModal').classList.remove('active');
        }, 1000);
        
    } catch(e) {
        alert("保存可用模型池失败: " + e.message);
    }
});

async function syncChannelBlacklistToGlobal(sourceId, isGptAll, selectedOrigIds) {
    const channelModels = getChannelFilteredModels(sourceId, isGptAll);
    const channelFullIds = new Set(channelModels.map(m => m.value || m.origId));
    const selectedFullIds = new Set(
        selectedOrigIds.map(orig => {
            const m = channelModels.find(x => (x.origId || x.value) === orig);
            return m ? (m.value || m.origId) : orig;
        })
    );
    const next = getGlobalBlacklist().filter(id => !channelFullIds.has(id));
    selectedFullIds.forEach(id => { if (!next.includes(id)) next.push(id); });
    const response = await requestJson("/admin/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blacklistedModels: next.join(",") })
    });
    state.config = response.config || state.config;
}

window.openTestModal = function(modelName) {
    document.getElementById('testModelName').textContent = `目标对象: ${modelName}`;
    document.getElementById('testModelName').dataset.testModel = modelName;
    document.getElementById('testResultBox').textContent = "等待测试...";
    
    // Remember global test prompt
    const savedPrompt = window.localStorage.getItem("ai8_hub_global_test_prompt");
    if(savedPrompt) {
        document.getElementById('testPromptInput').value = savedPrompt;
    }
    
    // hide models list if we want clean UI
    document.getElementById('modelsModal').classList.remove('active');
    document.getElementById('testModal').classList.add('active');
}

async function runModelTest() {
    const targetModel = document.getElementById('testModelName').dataset.testModel;
    const prompt = document.getElementById('testPromptInput').value.trim();
    if (!prompt) return alert("测试提示词不可为空！");
    
    // Save state globally
    window.localStorage.setItem("ai8_hub_global_test_prompt", prompt);
    const box = document.getElementById('testResultBox');
    box.textContent = "请求握手中... (请耐心等待对方节点的响应流)";
    
    // Attempt standard ChatGPT request
    try {
        const aiRequest = {
            model: targetModel,
            messages: [{ "role": "user", "content": prompt }]
        };
        const response = await fetch("/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${state.adminToken}`
            },
            body: JSON.stringify(aiRequest)
        });
        
        const rawText = await response.text();
        let payload = {};
        try { payload = JSON.parse(rawText); } catch(e) { payload = { _raw: rawText }; }

        if(!response.ok) {
            box.textContent = `❌ 测试失联 | 状态码: ${response.status}\n\n` + (payload._raw || JSON.stringify(payload, null, 2));
        } else {
            const msg = payload.choices?.[0]?.message?.content || payload.choices?.[0]?.delta?.content || (payload._raw ? payload._raw : JSON.stringify(payload, null, 2));
            box.textContent = msg;
        }
    } catch(err) {
        box.textContent = `❌ 内核崩溃 | ${err.message}`;
    }
}

// ----- Dash & Utility -----
function renderRuntime(runtime) {
    const auth = runtime.auth || {};
    const config = runtime.config || {};
    const network = runtime.network || {};

    const entries = [
        ["独立服务器节点 IP 候选", (network.ipv4_candidates || []).join(", ") || "-"],
        ["外部暴露地址网络环境", network.preferred_base_url || "-"],
        ["Cherry Studio 通信拦截口", network.openai_base_url || "-"],
        ["内部系统身份认证模式", auth.admin_mode || "-"],
        ["API Key (客户端访问) 数量", String(auth.api_key_count || 0)],
        ["是否存活联机状态", auth.upstream_ready ? "联通" : "断连"],
    ];

    elements.runtimeGrid.innerHTML = entries
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join("");
}

function renderExample() {
    const runtime = state.runtime || {};
    const network = runtime.network || {};
    const config = state.config || {};
    const openaiBaseUrl = network.openai_base_url || "";
    const apiKey = String(config.apiKeys || "").split(",")[0] || "YOUR_KEY";

    if (!openaiBaseUrl) {
        elements.exampleOutput.textContent = "当前还没有可用的 OpenAI API 地址，需要先保存网关配置。";
        return;
    }

    elements.exampleOutput.textContent = [
        `Base URL: ${openaiBaseUrl}`,
        `API Key: ${apiKey}`,
        ``,
        `注意：针对 Anthropic(Claude) 格式调用：`,
        `请在 Cherry Studio 填入上述 Base URL 和对应 Key，引擎库会自动翻译并穿透至各个后端渠道。`
    ].join("\n");
}

function renderConfig(config) {
    elements.adminTokenConfig.value = config.adminToken || "";
    elements.ai8BaseUrl.value = config.ai8BaseUrl || "";
    elements.ai8AuthToken.value = config.ai8AuthToken || "";
    elements.ai8DefaultModel.value = config.ai8DefaultModel || "";
    if (elements.ai8RequestTimeoutMs) elements.ai8RequestTimeoutMs.value = config.ai8RequestTimeoutMs || "";
    if (elements.ai8DeleteSessionAfterResponse) elements.ai8DeleteSessionAfterResponse.value = config.ai8DeleteSessionAfterResponse === true ? "true" : "false";
    elements.apiKeys.value = config.apiKeys || "";
    if (elements.gptallEnabled) elements.gptallEnabled.value = config.gptallEnabled === true ? "true" : "false";
    if (elements.gptallBaseUrl) elements.gptallBaseUrl.value = config.gptallBaseUrl || "";
    if (elements.gptallAuthToken) elements.gptallAuthToken.value = config.gptallAuthToken || "";
    if (elements.gptallCookie) elements.gptallCookie.value = config.gptallCookie || "";
    if (elements.gptallFingerprint) elements.gptallFingerprint.value = config.gptallFingerprint || "";
    if (elements.gptallDefaultModel) elements.gptallDefaultModel.value = config.gptallDefaultModel || "";
    if (elements.gptallAllowedModels) elements.gptallAllowedModels.value = config.gptallAllowedModels || "";
    if (elements.gptallRequestTimeoutMs) elements.gptallRequestTimeoutMs.value = config.gptallRequestTimeoutMs || "";
}

async function loadLogs() {
    try {
        const payload = await requestJson("/admin/api/logs?limit=200");
        const lines = Array.isArray(payload.tail_lines) ? payload.tail_lines : [];
        elements.logsOutput.textContent = lines.length > 0 ? lines.join("\n") : "当前系统追踪堆栈全空...。";
        elements.logsOutput.scrollTop = elements.logsOutput.scrollHeight;
    } catch (error) {
        elements.logsOutput.textContent = "解析日志堆栈失败" + error.message;
    }
}

// --- Utils ---
async function requestJson(url, options = {}) {
    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${state.adminToken}`,
    };
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`;
        throw new Error(message);
    }
    return payload;
}

function setStatus(message, type = "") {
    if(message==="") { elements.statusBanner.className = "status-banner"; elements.statusBanner.textContent = ""; return; }
    elements.statusBanner.className = `status-banner${type ? ` ${type}` : ""}`;
    elements.statusBanner.textContent = message;
}

function toNumberString(value) {
    const trimmed = String(value || "").trim();
    return trimmed === "" ? "" : (Number.isFinite(Number(trimmed)) ? String(Number(trimmed)) : "");
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
