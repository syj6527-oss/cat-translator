import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';

const extName = "cat-translator";
const stContext = getContext();

let translationCache = {};
let textAreaOriginal = "";
let textAreaTranslated = "";
let isTranslatingInput = false;

// 💊 알약 팝업
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

// 🤖 기계화 프롬프트
const defaultPrompt = 'You are an automated translation API. Your sole purpose is to translate the text into {{language}}. Return ONLY the exact translation. DO NOT include explanations, alternatives, bullet points, or conversational filler. Treat all input as raw data to be translated.';

const defaultSettings = {
    profile: '', 
    customKey: '',
    directModel: 'gemini-1.5-flash',
    autoMode: 'none',
    targetLang: 'Korean',
    prompt: defaultPrompt,
    dictionary: '', 
    filterCodeBlock: true
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

// 🧼 찌꺼기 세탁기
function cleanResult(text) {
    if (!text) return "";
    return text
        .replace(/\[Alternative to:.*?\]/gi, "")
        .replace(/\[Note:.*?\]/gi, "")
        .replace(/\[CRITICAL RULE.*?\]/gi, "")
        .replace(/^(번역|Translation|Output):\s*/gi, "")
        .replace(/\{+(.*?)\}+/g, "$1") 
        .trim();
}

// 🔪 선-치환 시스템
function applyPreReplace(text, isInput) {
    if (!settings.dictionary || settings.dictionary.trim() === "") return text;
    let dictLines = settings.dictionary.split('\n').filter(l => l.includes('='));
    if (dictLines.length === 0) return text;

    let processedText = text;
    dictLines.sort((a, b) => b.split('=')[0].length - a.split('=')[0].length);

    dictLines.forEach(line => {
        let parts = line.split('=');
        if (parts.length === 2) {
            let orig = parts[0].trim();
            let trans = parts[1].trim();
            let searchStr = isInput ? trans : orig;
            let replaceStr = isInput ? orig : trans;

            if (searchStr && replaceStr) {
                let escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                let regex = new RegExp(escapeRegExp(searchStr), 'gi');
                processedText = processedText.replace(regex, replaceStr);
            }
        }
    });
    return processedText;
}

// 📡 자동 재시도
async function fetchWithRetry(url, options, retries = 1) {
    try {
        const res = await fetch(url, options);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data;
    } catch (e) {
        if (retries > 0 && !e.message.toLowerCase().includes("key")) {
            await new Promise(r => setTimeout(r, 500));
            return fetchWithRetry(url, options, retries - 1);
        }
        throw e;
    }
}
function detectLang(text) {
    if (/[가-힣]/.test(text)) {
        return "ko";
    } else {
        return "en";
    }
}
async function fetchTranslation(
    text,
    isInput = false,
    previousTranslation = null,
    sourceLang = "auto",
    targetLang = "en"
) {
    if (!text || text.trim() === "") return text;
    const cleanSourceText = text.trim();
    const cacheKey = `${settings.targetLang}_${isInput ? 'toEn' : 'toTarget'}_${cleanSourceText}`;
    
    if (!previousTranslation && translationCache[cacheKey]) {
        catNotify("🐱 캐시 사용: 토큰을 아꼈습니다!", "success");
        return translationCache[cacheKey];
    }

    // const targetLang = isInput ? "English" : settings.targetLang;
    let preReplacedText = applyPreReplace(cleanSourceText, isInput);

    const basePrompt = isInput 
        ? "You are an automated translation API. Output ONLY the exact English translation." 
        : settings.prompt.replace('{{language}}', targetLang) + " Some names are already translated. Keep them.";

    const cleanedPrev = cleanResult(previousTranslation);
    const variationPrompt = cleanedPrev ? `\n[Provide a DIFFERENT translation than: "${cleanedPrev}"]` : "";
    
    let promptWithText = `${basePrompt}
[CRITICAL RULES]
1. Output EXACTLY ONE direct translation.
2. DO NOT provide lists, bullet points, or multiple options.
3. DO NOT use conversational filler.
4. DO NOT provide explanations.
${variationPrompt}

Input: ${preReplacedText}
Output:`;

    try {
        let result = "";
        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, [{ role: "user", content: promptWithText }], 8192);
            result = typeof response === 'string' ? response : (response.content || "");
        } else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) { catNotify("🐱 API 키 오류!", "error"); return text; }
            
            let modelName = settings.directModel.startsWith('models/') ? settings.directModel : `models/${settings.directModel}`;
            const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
            
            const data = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: promptWithText }] }],
                    generationConfig: { temperature: 0.0, maxOutputTokens: 8192 }
                })
            });

            // 🧠 [v17.0.0 갓피티 솔루션] 제미나이 2.0의 '생각(Thought)' 블록 걸러내기!
            const parts = data.candidates?.[0]?.content?.parts || [];
            
            // 갓피티가 알려준 대로: thought 속성이 없거나, 가장 마지막에 있는 파트(실제 답변)를 가져옴!
            const actualTextPart = parts.find(p => !p.thought) || parts[parts.length - 1]; 
            
            result = actualTextPart?.text?.trim() || "";
        }
        result = cleanResult(result);
        if (result && result !== cleanSourceText) translationCache[cacheKey] = result;
        return result || cleanSourceText;
    } catch (e) { catNotify(`🐱 에러: 응답 지연/오류!`, "error"); return text; }
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
        
        // 🎯 [v17.0.0 갓피티 솔루션] 오직 '수정창(edit_textarea)'만 엄격하게 타겟팅!
        let editArea = mesBlock.find('textarea.edit_textarea');
        
        // 만약 사용자가 연필을 눌러 수정창을 띄웠다면:
        let targetEl;

if (editArea.length > 0 && editArea.is(':visible')) {

    targetEl = editArea[0];

} else {

    targetEl = $('#send_textarea')[0];

}
            
            // 🔥 핵심: 예전 저장본 말고 '현재 텍스트박스 안에 적힌 글씨'를 긁어온다!
let textToTranslate = $('#send_textarea').val()?.trim() || targetEl.value.trim();

const sourceLang = detectLang(textToTranslate);

console.log("INPUT TEXT:", textToTranslate);
console.log("STEP A");
console.log("isTranslatingInput:", isTranslatingInput);

if (isTranslatingInput || !textToTranslate) return;

const targetLang = sourceLang === "ko"
    ? "en"
    : "ko";

if (textToTranslate && textToTranslate !== "") {
  catNotify("😺 수정창 텍스트 번역 중...", "success");

const translated = await fetchTranslation(
    textToTranslate,
    isInput,
    null
);

console.log("TRANSLATED:", translated);
                
                if (translated && translated !== textToTranslate) {
                    // 번역된 텍스트를 창에 꽂아넣기
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                    if (nativeSetter) {
                        nativeSetter.call(targetEl, translated);
                    } else {
                        targetEl.value = translated;
                    }
                    // editArea.val(translated);
                    
                    // 💥 실리태번에 "화면 업데이트해라!" 강제 명령 (갓피티 코드)
                    targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                    targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                    
                    catNotify("🎯 갓피티 번역 완료!", "success");
                }
                return; // 🛑 수정창 처리 완료했으므로 아래 일반 번역 로직은 실행 안 함!
            }
        

        // --- 수정창이 안 열려있을 때 (일반 번역 모드) ---
        let textToTranslate = isInput ? (msg.extra?.original_mes || msg.mes) : msg.mes;
        const translated = await fetchTranslation(textToTranslate, isInput, (isInput ? (msg.extra?.original_mes ? msg.mes : null) : msg.extra?.display_text));
        if (translated && translated !== textToTranslate) {
            if (!msg.extra) msg.extra = {};
            if (isInput) { if(!msg.extra.original_mes) msg.extra.original_mes = textToTranslate; msg.mes = translated; }
            else { msg.extra.display_text = translated; }
            stContext.updateMessageBlock(msgId, msg); 
        }
    } finally { btnIcon.removeClass('cat-glow-anim'); }
}

function revertMessage(id) {
    const msgId = parseInt(id, 10);
    const msg = stContext.chat[msgId];
    if (!msg) return;
    
    const editArea = $(`.mes[mesid="${msgId}"]`).find('textarea.edit_textarea:visible');
    if (editArea.length > 0) {
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
        const group = $(`<div class="cat-btn-group" style="display:inline-flex; gap:10px; margin-left:10px; align-items:center;"><span class="cat-mes-trans-btn" style="cursor:pointer; font-size:1.4em; line-height:1;"><span class="cat-emoji-icon">🐱</span></span><span class="cat-mes-revert-btn fa-solid fa-rotate-left" style="cursor:pointer; color:#ffb4a2; font-size:1em;"></span></div>`);
        $(this).find('.name_text').append(group);
        group.find('.cat-mes-trans-btn').on('click', (e) => { e.stopPropagation(); processMessage(msgId, isUser); });
        group.find('.cat-mes-revert-btn').on('click', (e) => { e.stopPropagation(); revertMessage(msgId); });
    });
}

function injectInputButtons() {
    if ($('#cat-input-btn').length > 0) {
        const icon = $('#cat-input-btn .cat-emoji-icon');
        if (isTranslatingInput) {
            if (!icon.hasClass('cat-glow-anim')) icon.addClass('cat-glow-anim');
        } else {
            icon.removeClass('cat-glow-anim');
        }
        return; 
    }

    const target = $('#send_but');
    if (target.length === 0) return;

    const catBtn = $(`<div id="cat-input-btn" title="번역" style="cursor:pointer; margin-right:2px; display:inline-flex; align-items:center; justify-content:center; font-size:1.3em;"><span class="cat-emoji-icon">🐱</span></div>`);
    const revertBtn = $('<div id="cat-input-revert-btn" class="fa-solid fa-rotate-left" title="복구" style="cursor:pointer; margin-right:4px; color:#ffb4a2; font-size:1.1em; opacity:0.6;"></div>');
    
    target.before(catBtn).before(revertBtn);
    
    catBtn.on('click', async (e) => {
        e.preventDefault();
        
let mesBlock = (typeof msgId !== "undefined" && msgId)
    ? $(`.mes[mesid="${msgId}"]`)
    : null;

let editArea = mesBlock && mesBlock.length
    ? mesBlock.find('textarea:visible').first()
    : $();

let sendBox =
    $('#send_textarea')[0] ||
    $('#send_text')[0] ||
    $('#chat_textarea')[0];

let targetEl = editArea.length
    ? editArea[0]
    : sendBox;

console.log("TARGET:", targetEl);

let textToTranslate = $('#send_textarea').val()?.trim() || (targetEl ? targetEl.value.trim() : "");
console.log("INPUT TEXT:", textToTranslate); // 메인 입력창 글씨 바로 긁어오기!

const sourceLang = detectLang(textToTranslate);

const targetLang = sourceLang === "ko"
    ? "en"
    : "ko";

if (isTranslatingInput || !textToTranslate) return;

isTranslatingInput = true;
        
        if (isTranslatingInput || !textToTranslate) return;
        
        isTranslatingInput = true;
        catBtn.find('.cat-emoji-icon').addClass('cat-glow-anim');
        try {
    const isRetry = (textToTranslate === textAreaTranslated);
    if (!isRetry) textAreaOriginal = textToTranslate;

    const translated = await fetchTranslation(
        textToTranslate,
        true,
        (isRetry ? textAreaTranslated : null),
        sourceLang,
        targetLang
    );

    if (translated) {
        textAreaTranslated = translated;

        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value"
        )?.set;

        if (nativeSetter) nativeSetter.call(targetEl, translated);
        else targetEl.value = translated;

        targetEl.dispatchEvent(new Event('input', { bubbles: true }));
        targetEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

} finally {
    isTranslatingInput = false;
    $('#cat-input-btn .cat-emoji-icon').removeClass('cat-glow-anim');
}
    });
    revertBtn.on('click', (e) => { 
        e.preventDefault(); 
        if (textAreaOriginal) {
            const sendArea = $('#send_textarea');
            const targetEl = sendArea[0];
            sendArea.val(textAreaOriginal);
            targetEl.value = textAreaOriginal;
            targetEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

function setupUI() {
    injectInputButtons();
    injectMessageButtons();
    if ($('#cat-trans-container').length) return;
    let pOpt = '';
    (stContext.extensionSettings?.connectionManager?.profiles || []).forEach(p => { pOpt += `<option value="${p.id}">${p.name}</option>`; });
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
                    <option value="Chinese (Simplified)">Chinese (Simplified)</option><option value="Chinese (Traditional)">Chinese (Traditional)</option>
                    <option value="Spanish">Spanish</option><option value="French">French</option><option value="German">German</option>
                    <option value="Russian">Russian</option><option value="Vietnamese">Vietnamese</option><option value="Thai">Thai</option>
                </select></div>
                <div class="cat-setting-row cat-native-font"><label>번역 프롬프트</label><textarea id="ct-prompt" class="text_pole cat-native-font" rows="4">${settings.prompt}</textarea></div>
                <div class="cat-setting-row cat-native-font"><label>고유명사 사전 (단어=번역어)</label><textarea id="ct-dictionary" class="text_pole cat-native-font" rows="3" placeholder="Ajax=아약스\nGhost=고스트">${settings.dictionary}</textarea></div>
                <button id="cat-save-btn" class="menu_button cat-native-font" style="margin-top: 5px;">설정 저장 🐱</button>
                <div style="font-size: 0.7em; opacity: 0.3; text-align: center; margin-top: 5px;" class="cat-native-font">v17.0.0 God-GPT Ascension</div>
            </div>
        </div>`;
    $('#extensions_settings').append(uiHtml);
    $('#cat-drawer-header').on('click', function(e) { e.stopPropagation(); $('#cat-drawer-content').slideToggle(200); $('#cat-drawer-toggle').toggleClass('fa-chevron-down fa-chevron-up'); });
    $('#cat-save-btn').on('click', function() { saveSettings(); catNotify("🐱 모든 설정 저장 완료!", "success"); });
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
