import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';

const extName = "cat-translator";
const stContext = getContext();

let translationCache = {};
let textAreaOriginal = "";
let textAreaTranslated = "";
let isTranslatingInput = false;

// 💊 알림창
function catNotify(message, type = 'success') {
    $('.cat-notification').remove();
    const bgColor = type === 'success' ? '#2ecc71' : (type === 'warning' ? '#f1c40f' : '#e74c3c');
    const notifyHtml = $(`<div class="cat-notification cat-native-font" style="background-color: ${bgColor};">${message}</div>`);
    $('body').append(notifyHtml);
    setTimeout(() => { notifyHtml.addClass('show'); }, 10);
    setTimeout(() => {
        notifyHtml.removeClass('show');
        setTimeout(() => { notifyHtml.remove(); }, 500);
    }, 2500);
}

const defaultPrompt = 'You are a direct translation engine. Translate the input into {{language}} exactly. Output ONLY the raw translation without any explanations.';

const defaultSettings = {
    profile: '', 
    customKey: '',
    directModel: 'gemini-1.5-flash',
    autoMode: 'none',
    targetLang: 'Korean',
    prompt: defaultPrompt,
    dictionary: ''
};

let settings = Object.assign({}, defaultSettings, extension_settings[extName]);
if (!settings.prompt || settings.prompt.trim() === "") settings.prompt = defaultPrompt;

function saveSettings() {
    settings.prompt = $('#ct-prompt').val() || settings.prompt;
    settings.targetLang = $('#ct-lang').val() || settings.targetLang;
    settings.directModel = $('#ct-model').val() || settings.directModel;
    settings.autoMode = $('#ct-auto-mode').val() || settings.autoMode;
    settings.profile = $('#ct-profile').val() || '';
    settings.customKey = $('#ct-key').val() || '';
    settings.dictionary = $('#ct-dictionary').val() || '';
    extension_settings[extName] = settings;
    stContext.saveSettingsDebounced();
    translationCache = {}; 
}

function cleanResult(text) {
    if (!text) return "";
    return text.replace(/^(번역|Translation|Output):\s*/gi, "").replace(/\{+(.*?)\}+/g, "$1").trim();
}

function applyPreReplace(text, isInput) {
    if (!settings.dictionary || settings.dictionary.trim() === "") return text;
    let dictLines = settings.dictionary.split('\n').filter(l => l.includes('='));
    if (dictLines.length === 0) return text;

    let processedText = text;
    dictLines.sort((a, b) => b.split('=')[0].length - a.split('=')[0].length);

    dictLines.forEach(line => {
        let parts = line.split('=');
        if (parts.length === 2) {
            let orig = parts[0].trim(), trans = parts[1].trim();
            let searchStr = isInput ? trans : orig;
            let replaceStr = isInput ? orig : trans;
            if (searchStr && replaceStr) {
                let escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                processedText = processedText.replace(new RegExp(escapeRegExp(searchStr), 'gi'), replaceStr);
            }
        }
    });
    return processedText;
}

async function fetchTranslation(text, isInput = false, previousTranslation = null) {
    if (!text || text.trim() === "") return text;
    const cacheKey = `${settings.targetLang}_${isInput ? 'toEn' : 'toTarget'}_${text.trim()}`;
    if (!previousTranslation && translationCache[cacheKey]) return translationCache[cacheKey];

    const targetLang = isInput ? "English" : settings.targetLang;
    let preReplacedText = applyPreReplace(text.trim(), isInput);
    
    let promptWithText = isInput 
        ? `Translate ONLY to English.\nInput: ${preReplacedText}\nOutput:`
        : `${settings.prompt.replace('{{language}}', targetLang)}\nInput: ${preReplacedText}\nOutput:`;

    try {
        let result = "";
        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, [{ role: "user", content: promptWithText }], 8192);
            result = typeof response === 'string' ? response : (response.content || "");
        } else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) { catNotify("🐱 API 키 오류!", "error"); return text; }
            
            const model = settings.directModel.startsWith('models/') ? settings.directModel : `models/${settings.directModel}`;
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: promptWithText }] }],
                    generationConfig: { temperature: 0.0, maxOutputTokens: 8192 }
                })
            });
            const data = await response.json();
            
            const parts = data.candidates?.[0]?.content?.parts || [];
            const actualPart = parts.find(p => !p.thought) || parts[parts.length - 1]; 
            result = actualPart?.text?.trim() || "";
        }
        
        result = cleanResult(result);
        if (result) translationCache[cacheKey] = result;
        return result || text;
    } catch (e) {
        catNotify("🐱 에러: " + e.message, "error");
        return text;
    }
}

async function processMessage(id, isInput = false) {
    const msgId = parseInt(id, 10);
    const msg = stContext.chat[msgId];
    if (!msg) return;
    const btnIcon = $(`.mes[mesid="${msgId}"]`).find('.cat-mes-trans-btn .cat-emoji-icon');
    
    if (btnIcon.hasClass('cat-glow-anim')) return;
    btnIcon.addClass('cat-glow-anim');
    
    try {
        const mesBlock = $(`.mes[mesid="${msgId}"]`);
        
        // 🎯 [v17.3.0] 지피티의 최종 결론: 무적의 다중 타겟팅 콤보!
        let editArea = mesBlock.find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible, textarea:visible').first();
        
        if (editArea.length > 0) {
            let currentText = editArea.val().trim();
            if (!currentText) return;

            catNotify("🐱 수정창 번역 중...", "success");
            const translated = await fetchTranslation(currentText, isInput, null);
            
            if (translated && translated !== currentText) {
                const targetEl = editArea[0];
                
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                if (nativeSetter) {
                    nativeSetter.call(targetEl, translated);
                } else {
                    targetEl.value = translated;
                }
                editArea.val(translated); 
                
                targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                
                catNotify("🎯 수정창 번역 완료!", "success");
            }
            return; 
        }

        // 일반 모드
        let textToTranslate = isInput ? (msg.extra?.original_mes || msg.mes) : msg.mes;
        const translated = await fetchTranslation(textToTranslate, isInput, (isInput ? (msg.extra?.original_mes ? msg.mes : null) : msg.extra?.display_text));
        
        if (translated && translated !== textToTranslate) {
            if (!msg.extra) msg.extra = {};
            if (isInput) { 
                if(!msg.extra.original_mes) msg.extra.original_mes = textToTranslate; 
                msg.mes = translated; 
            } else { 
                msg.extra.display_text = translated; 
            }
            stContext.updateMessageBlock(msgId, msg); 
        }
    } finally { btnIcon.removeClass('cat-glow-anim'); }
}

function revertMessage(id) {
    const msgId = parseInt(id, 10);
    const msg = stContext.chat[msgId];
    if (!msg) return;
    
    // 🎯 복구 버튼도 동일하게 무적 타겟팅 적용
    if ($(`.mes[mesid="${msgId}"]`).find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible, textarea:visible').length > 0) {
        catNotify("🐱 수정 중에는 복구할 수 없습니다.", "warning");
        return;
    }
    
    if (msg.extra?.display_text) delete msg.extra.display_text;
    if (msg.extra?.original_mes) { msg.mes = msg.extra.original_mes; delete msg.extra.original_mes; }
    stContext.updateMessageBlock(msgId, msg);
}

function injectMessageButtons() {
    $('.mes:not(:has(.cat-btn-group))').each(function() {
        const msgId = $(this).attr('mesid');
        if (!msgId) return;
        const isUser = $(this).hasClass('mes_user');
        const group = $(`<div class="cat-btn-group" style="display:inline-flex; gap:10px; margin-left:10px; align-items:center;"><span class="cat-mes-trans-btn" style="cursor:pointer; font-size:1.4em;"><span class="cat-emoji-icon">🐱</span></span><span class="cat-mes-revert-btn fa-solid fa-rotate-left" style="cursor:pointer; color:#ffb4a2;"></span></div>`);
        $(this).find('.name_text').append(group);
        group.find('.cat-mes-trans-btn').on('click', (e) => { e.stopPropagation(); processMessage(msgId, isUser); });
        group.find('.cat-mes-revert-btn').on('click', (e) => { e.stopPropagation(); revertMessage(msgId); });
    });
}

function injectInputButtons() {
    if ($('#cat-input-btn').length > 0) {
        const icon = $('#cat-input-btn .cat-emoji-icon');
        if (isTranslatingInput) icon.addClass('cat-glow-anim'); else icon.removeClass('cat-glow-anim');
        return; 
    }
    const target = $('#send_but');
    if (target.length === 0) return;
    const catBtn = $(`<div id="cat-input-btn" title="번역" style="cursor:pointer; margin-right:2px; display:inline-flex; align-items:center; font-size:1.3em;"><span class="cat-emoji-icon">🐱</span></div>`);
    const revertBtn = $('<div id="cat-input-revert-btn" class="fa-solid fa-rotate-left" title="복구" style="cursor:pointer; margin-right:4px; color:#ffb4a2; opacity:0.6;"></div>');
    target.before(catBtn).before(revertBtn);
    catBtn.on('click', async (e) => {
        e.preventDefault();
        const sendArea = $('#send_textarea');
        let text = sendArea.val().trim();
        if (isTranslatingInput || !text) return;
        isTranslatingInput = true; catBtn.find('.cat-emoji-icon').addClass('cat-glow-anim');
        try {
            const isRetry = (text === textAreaTranslated);
            if (!isRetry) textAreaOriginal = text;
            const trans = await fetchTranslation(text, true, (isRetry ? textAreaTranslated : null));
            if (trans) { 
                textAreaTranslated = trans;
                const targetEl = sendArea[0];
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                if (setter) setter.call(targetEl, trans); else targetEl.value = trans;
                sendArea.val(trans).trigger('input');
                targetEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } finally { isTranslatingInput = false; $('#cat-input-btn .cat-emoji-icon').removeClass('cat-glow-anim'); }
    });
    revertBtn.on('click', (e) => { e.preventDefault(); if (textAreaOriginal) { $('#send_textarea').val(textAreaOriginal).trigger('input'); $('#send_textarea')[0].dispatchEvent(new Event('input', { bubbles: true })); } });
}

function setupUI() {
    injectInputButtons(); injectMessageButtons();
    if ($('#cat-trans-container').length) return;
    let pOpt = ''; (stContext.extensionSettings?.connectionManager?.profiles || []).forEach(p => { pOpt += `<option value="${p.id}">${p.name}</option>`; });
    const uiHtml = `
        <div id="cat-trans-container" class="inline-drawer cat-native-font">
            <div id="cat-drawer-header" class="inline-drawer-header interactable" tabindex="0">
                <div class="inline-drawer-title cat-native-font">🐱 <span>트랜스레이터</span></div>
                <i id="cat-drawer-toggle" class="inline-drawer-toggle fa-solid fa-chevron-down"></i>
            </div>
            <div id="cat-drawer-content" class="inline-drawer-content" style="display: none; padding: 10px;">
                <div class="cat-setting-row cat-native-font"><label>연결 프로필</label><select id="ct-profile" class="text_pole cat-native-font"><option value="">⚡ 직접 연결 모드</option>${pOpt}</select></div>
                <div id="direct-mode-settings" style="display: ${settings.profile === '' ? 'block' : 'none'};">
                    <div class="cat-setting-row cat-native-font"><label>API Key</label><input type="password" id="ct-key" class="text_pole cat-native-font" value="${settings.customKey}"></div>
                    <div class="cat-setting-row cat-native-font"><label>모델</label><select id="ct-model" class="text_pole cat-native-font">
                        <option value="gemini-1.5-flash">Gemini 1.5 Flash</option><option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                        <option value="gemini-2.0-flash">Gemini 2.0 Flash</option><option value="gemini-2.0-pro-exp-02-05">Gemini 2.0 Pro Exp</option>
                    </select></div>
                </div>
                <div class="cat-setting-row cat-native-font"><label>자동 모드</label><select id="ct-auto-mode" class="text_pole cat-native-font"><option value="none">꺼짐</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                <div class="cat-setting-row cat-native-font"><label>목표 언어</label><select id="ct-lang" class="text_pole cat-native-font">
                    <option value="Korean">Korean</option><option value="English">English</option><option value="Japanese">Japanese</option>
                </select></div>
                <div class="cat-setting-row cat-native-font"><label>번역 프롬프트</label><textarea id="ct-prompt" class="text_pole cat-native-font" rows="4">${settings.prompt}</textarea></div>
                <div class="cat-setting-row cat-native-font"><label>사전 (A=B)</label><textarea id="ct-dictionary" class="text_pole cat-native-font" rows="3">${settings.dictionary}</textarea></div>
                <button id="cat-save-btn" class="menu_button cat-native-font" style="margin-top: 5px;">설정 저장 🐱</button>
                <div style="font-size: 0.7em; opacity: 0.3; text-align: center; margin-top: 5px;" class="cat-native-font">v17.3.0 GPT's Final Target</div>
            </div>
        </div>`;
    $('#extensions_settings').append(uiHtml);
    $('#cat-drawer-header').on('click', function(e) { e.stopPropagation(); $('#cat-drawer-content').slideToggle(200); $('#cat-drawer-toggle').toggleClass('fa-chevron-down fa-chevron-up'); });
    $('#cat-save-btn').on('click', function() { saveSettings(); catNotify("🐱 설정 저장 완료!"); });
    $('#ct-profile').val(settings.profile).on('change', function() { settings.profile = $(this).val(); $('#direct-mode-settings').toggle(settings.profile === ''); saveSettings(); });
    $('#ct-key').on('input', function() { settings.customKey = $(this).val(); });
    $('#ct-model').val(settings.directModel).on('change', function() { settings.directModel = $(this).val(); saveSettings(); });
    $('#ct-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
    $('#ct-lang').val(settings.targetLang).on('change', function() { settings.targetLang = $(this).val(); saveSettings(); });
    $('#ct-dictionary').on('input', function() { settings.dictionary = $(this).val(); });
}

jQuery(() => {
    setupUI();
    setInterval(() => { injectInputButtons(); injectMessageButtons(); }, 250);
    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, (d) => {
        if (settings.autoMode === 'none' || settings.autoMode === 'input') return;
        processMessage(typeof d === 'object' ? d.messageId : d, false);
    });
    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, (d) => {
        if (settings.autoMode === 'none' || settings.autoMode === 'output') return;
        processMessage(typeof d === 'object' ? d.messageId : d, true);
    });
});
