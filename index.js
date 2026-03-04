import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';

const extName = "cat-translator";
const stContext = getContext();

// 전역 상태
let translationCache = {};
let textAreaOriginal = "";
let textAreaTranslated = "";

const defaultPrompt = 'You are a professional translator. Your absolute mission is to translate EVERY piece of natural language text into {{language}}, regardless of its location.\n\n[MANDATORY]\n1. Translate text inside code blocks (```), HTML comments (<!-- text -->), and all tags (<summary>, <details>, <memo>, <font>).\n2. KEEP all structural symbols, brackets, and code syntax EXACTLY as they are. Only swap English words for {{language}}.\n3. DO NOT translate HTML attributes or CSS property names.\n4. Output ONLY the translated result without any commentary.';

const defaultSettings = {
    profile: '', 
    customKey: '',
    directModel: 'gemini-1.5-flash',
    autoMode: 'none',
    targetLang: 'Korean',
    prompt: defaultPrompt,
    filterCodeBlock: true,
    maxTokens: 0
};

let settings = Object.assign({}, defaultSettings, extension_settings[extName]);
if (!settings.prompt || settings.prompt.trim() === "") {
    settings.prompt = defaultPrompt;
}

// 저장 로직 (유실 방지)
function saveSettings() {
    const currentPrompt = $('#ct-prompt').val();
    if (currentPrompt !== undefined) settings.prompt = currentPrompt;
    extension_settings[extName] = settings;
    stContext.saveSettingsDebounced();
    translationCache = {}; 
}

// 중첩 태그 청소 로직 (v6.1.0 fix 유지)
function cleanResult(text) {
    if (!text) return "";
    return text
        .replace(/\[Alternative to:.*?\]/gs, "")
        .replace(/\[Note:.*?\]/gs, "")
        .replace(/\[CRITICAL:.*?\]/gs, "")
        .trim();
}

async function fetchTranslation(text, isInput = false, previousTranslation = null) {
    if (!text || text.trim() === "") return text;

    const cacheKey = `${settings.targetLang}_${isInput ? 'toEn' : 'toTarget'}_${text}`;
    if (!previousTranslation && translationCache[cacheKey]) {
        toastr.info("🐱 캐시 사용: 토큰을 아꼈습니다!");
        return translationCache[cacheKey];
    }

    const targetLang = isInput ? "English" : settings.targetLang;
    const basePrompt = isInput 
        ? "Translate the following text into natural English. Preserve formatting." 
        : settings.prompt.replace('{{language}}', targetLang);

    const cleanedPrev = cleanResult(previousTranslation);
    const variationPrompt = cleanedPrev ? `\n\n[Note: Please provide a DIFFERENT phrasing than: "${cleanedPrev}"]` : "";
    const promptWithText = `${basePrompt}${variationPrompt}\n\n${text}`;

    try {
        let result = "";
        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, [{ role: "user", content: promptWithText }], 4096);
            if (!response) throw new Error("Connection Error");
            result = typeof response === 'string' ? response : (response.content || "");
        } 
        else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) { toastr.error("🐱 API 키가 없습니다!"); return text; }
            let modelName = settings.directModel;
            if (!modelName.startsWith('models/')) modelName = `models/${modelName}`;
            
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: promptWithText }] }],
                    generationConfig: { temperature: 0.4 },
                    safetySettings: [
                        { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
                        { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
                        { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
                        { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" },
                        { "category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE" }
                    ]
                })
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        }

        result = cleanResult(result);
        if (settings.filterCodeBlock && result) {
            let trimmed = result.trim();
            if (trimmed.startsWith("```") && trimmed.endsWith("```") && !text.trim().startsWith("```")) {
                const lines = trimmed.split('\n');
                if (lines.length > 2) result = lines.slice(1, -1).join('\n').trim();
            }
        }
        if (result && result !== text) translationCache[cacheKey] = result;
        return result || text;
    } catch (e) {
        toastr.error(`🐱 에러: ${e.message}`);
        return text;
    }
}

async function processMessage(id, isInput = false) {
    const msgId = parseInt(id, 10); 
    const msg = stContext.chat[msgId];
    if (!msg) return;
    const btnIcon = $(`.mes[mesid="${msgId}"]`).find('.cat-emoji-icon');
    btnIcon.addClass('cat-spin-anim');
    const startTime = Date.now();
    try {
        let textToTranslate = isInput ? (msg.extra?.original_mes || msg.mes) : msg.mes;
        let currentTranslatedText = isInput ? (msg.extra?.original_mes ? msg.mes : null) : msg.extra?.display_text;
        const translated = await fetchTranslation(textToTranslate, isInput, currentTranslatedText);
        if (translated && translated !== textToTranslate) {
            if (!msg.extra) msg.extra = {};
            if (isInput) { msg.extra.original_mes = textToTranslate; msg.mes = translated; }
            else { msg.extra.display_text = translated; }
            stContext.updateMessageBlock(msgId, msg); 
        }
    } finally {
        const diff = Math.max(0, 500 - (Date.now() - startTime));
        setTimeout(() => btnIcon.removeClass('cat-spin-anim'), diff);
    }
}

function revertMessage(id) {
    const msgId = parseInt(id, 10);
    const msg = stContext.chat[msgId];
    if (!msg) return;
    let changed = false;
    if (msg.extra?.display_text) { delete msg.extra.display_text; changed = true; }
    if (msg.extra?.original_mes) { msg.mes = msg.extra.original_mes; delete msg.extra.original_mes; changed = true; }
    if (changed) stContext.updateMessageBlock(msgId, msg);
}

// 💡 [v6.2.0] 입력창 UI 상시 유지 로직
function injectInputButtons() {
    if ($('#cat-input-btn').length) return; // 이미 있으면 패스

    const sendBut = $('#send_but');
    if (!sendBut.length) return;

    const catBtn = $('<div id="cat-input-btn" title="고양이 번역" style="cursor:pointer; margin-right:2px; display:inline-flex; align-items:center; font-size:1.3em;"><span class="cat-emoji-icon" style="display:inline-block; line-height:1;">🐱</span></div>');
    const revertBtn = $('<div id="cat-input-revert-btn" class="fa-solid fa-rotate-left" title="원본 복구" style="cursor:pointer; margin-right:4px; color:#ffb4a2; font-size:1.1em; opacity:0.6; transition:all 0.2s; display:inline-flex; align-items:center;"></div>');
    
    sendBut.before(catBtn).before(revertBtn);
    
    catBtn.on('click', async () => {
        const area = $('#send_textarea');
        const icon = catBtn.find('.cat-emoji-icon');
        if (!area.val() || icon.hasClass('cat-spin-anim')) return;
        icon.addClass('cat-spin-anim');
        const start = Date.now();
        try {
            const isRetry = (area.val() === textAreaTranslated);
            if (!isRetry) textAreaOriginal = area.val();
            const trans = await fetchTranslation(textAreaOriginal, true, (isRetry ? textAreaTranslated : null));
            if (trans) { textAreaTranslated = trans; area.val(trans).trigger('input'); }
        } finally {
            const diff = Math.max(0, 500 - (Date.now() - start));
            setTimeout(() => icon.removeClass('cat-spin-anim'), diff);
        }
    });
    revertBtn.on('click', () => { if (textAreaOriginal) $('#send_textarea').val(textAreaOriginal).trigger('input'); });
}

function setupUI() {
    injectInputButtons();

    if (!$('#cat-trans-container').length) {
        let profileOptions = '';
        (stContext.extensionSettings?.connectionManager?.profiles || []).forEach(p => { profileOptions += `<option value="${p.id}">${p.name}</option>`; });
        const uiHtml = `
            <div id="cat-trans-container" class="inline-drawer">
                <div class="inline-drawer-header interactable" tabindex="0">
                    <div class="inline-drawer-title"><span class="cat-emoji-icon" style="font-size:1.3em; line-height:1;">🐱</span><span>트랜스레이터</span></div>
                    <div class="inline-drawer-toggle fa-solid fa-chevron-down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <div class="cat-setting-row"><label>Connection Profile</label><select id="ct-profile" class="text_pole"><option value="">⚡ 직접 연결 모드</option>${profileOptions}</select></div>
                    <div id="direct-mode-settings" style="border-left: 2px solid #a8c7fa; padding-left: 10px; margin-bottom: 15px; display: ${settings.profile === '' ? 'block' : 'none'};">
                        <div class="cat-setting-row"><label>API Key</label><input type="password" id="ct-key" class="text_pole" placeholder="API Key"></div>
                        <div class="cat-setting-row"><label>Model</label><select id="ct-model" class="text_pole">
                            <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                            <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                            <option value="gemini-2.0-pro-exp-02-05">Gemini 2.0 Pro Exp</option>
                        </select></div>
                    </div>
                    <div class="cat-setting-row"><label>Auto Mode</label><select id="ct-auto-mode" class="text_pole"><option value="none">사용 안함</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                    <div class="cat-setting-row"><label>Target Language</label><select id="ct-lang" class="text_pole">
                        <option value="Korean">Korean</option><option value="English">English</option><option value="Japanese">Japanese</option>
                        <option value="Chinese (Simplified)">Chinese (Simplified)</option><option value="Spanish">Spanish</option>
                        <option value="French">French</option><option value="German">German</option><option value="Russian">Russian</option>
                        <option value="Vietnamese">Vietnamese</option>
                    </select></div>
                    <div class="cat-setting-row"><label>번역 프롬프트</label><textarea id="ct-prompt" class="text_pole" rows="4"></textarea>
                        <label style="display:flex; align-items:center; gap:5px; margin-top:8px; cursor:pointer; font-weight:normal; font-size:0.9em; opacity:0.8;"><input type="checkbox" id="ct-filter-code"> Filter Code Block</label>
                    </div>
                    <div class="cat-setting-row" style="margin-top: 15px;"><button id="cat-save-btn" class="menu_button">설정 저장 🐱</button></div>
                    <div style="font-size: 0.8em; opacity: 0.2; text-align: center; margin-top: 5px;">v6.2.0 Ultra Stable Build</div>
                </div>
            </div>
        `;
        $('#extensions_settings').append(uiHtml);
        $('#cat-trans-container .inline-drawer-header').on('click', function(e) { e.stopPropagation(); $(this).next('.inline-drawer-content').slideToggle(200); $(this).find('.inline-drawer-toggle').toggleClass('fa-rotate-180'); });
        $('#cat-save-btn').on('click', function() { saveSettings(); toastr.success("🐱 설정이 저장되었습니다!"); });
        $('#ct-profile').val(settings.profile).on('change', function() { settings.profile = $(this).val(); $('#direct-mode-settings').toggle(settings.profile === ''); saveSettings(); });
        $('#ct-key').val(settings.customKey).on('input', function() { settings.customKey = $(this).val(); saveSettings(); });
        $('#ct-model').val(settings.directModel).on('change', function() { settings.directModel = $(this).val(); saveSettings(); });
        $('#ct-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
        $('#ct-lang').val(settings.targetLang).on('change', function() { settings.targetLang = $(this).val(); saveSettings(); });
        $('#ct-prompt').val(settings.prompt).on('input', function() { settings.prompt = $(this).val(); });
        $('#ct-filter-code').prop('checked', settings.filterCodeBlock).on('change', function() { settings.filterCodeBlock = $(this).is(':checked'); saveSettings(); });
    }
}

jQuery(() => {
    setupUI();
    
    // 💡 [v6.2.0] 실시간 UI 감시: 답변 출력 중에도 버튼을 계속 다시 그림
    const observer = new MutationObserver(() => { injectInputButtons(); });
    observer.observe(document.querySelector('#send_container') || document.body, { childList: true, subtree: true });

    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, (d) => { const msgId = typeof d === 'object' ? d.messageId : d; if(['output', 'both'].includes(settings.autoMode)) processMessage(msgId, false); });
    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, (d) => { const msgId = typeof d === 'object' ? d.messageId : d; if(['input', 'both'].includes(settings.autoMode)) processMessage(msgId, true); });
    
    $(document).on('mouseenter touchstart', '.mes', function() {
        if (!$(this).find('.cat-btn-group').length) {
            const btnGroup = $('<div class="cat-btn-group" style="display:inline-flex; gap:12px; margin-left:10px; align-items:center;"></div>');
            const transBtn = $('<div class="cat-mes-trans-btn" title="번역" style="cursor:pointer; opacity:0.6; font-size:1.6em; line-height:1;"><span class="cat-emoji-icon" style="display:inline-block;">🐱</span></div>');
            const revertBtn = $('<div class="cat-mes-revert-btn fa-solid fa-rotate-left" title="복구" style="cursor:pointer; color:#ffb4a2; opacity:0.6; font-size:1.1em; margin-bottom: 2px;"></div>');
            btnGroup.append(transBtn).append(revertBtn);
            $(this).find('.name_text').append(btnGroup);
            transBtn.on('click', (e) => { e.stopPropagation(); processMessage($(this).attr('mesid'), $(this).closest('.mes').hasClass('mes_user')); });
            revertBtn.on('click', (e) => { e.stopPropagation(); revertMessage($(this).attr('mesid')); });
        }
    });
});
