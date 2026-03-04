import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';

const extName = "cat-translator";
const stContext = getContext();

let translationCache = {};
let textAreaOriginal = "";
let textAreaTranslated = "";

// 애니메이션 유지 상태 락
let isTranslatingInput = false;

// 기본 프롬프트 (태그 보호 + 설명충 방지)
const defaultPrompt = 'You are a professional translator. Your absolute mission is to translate EVERY piece of natural language text into {{language}}, regardless of its location.\n\n[MANDATORY]\n1. Translate text inside code blocks (```), HTML comments (<!-- text -->), and all tags (<summary>, <details>, <memo>, <font>).\n2. KEEP all structural symbols, brackets, and code syntax EXACTLY as they are. Only swap English words for {{language}}.\n3. DO NOT translate HTML attributes or CSS property names.\n4. Output ONLY the translated result without any commentary or explanations.';

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
if (!settings.prompt || settings.prompt.trim() === "") settings.prompt = defaultPrompt;

// 💡 안전 저장 로직
function saveSettings() {
    settings.prompt = $('#ct-prompt').val() || settings.prompt;
    settings.targetLang = $('#ct-lang').val() || settings.targetLang;
    settings.directModel = $('#ct-model').val() || settings.directModel;
    settings.autoMode = $('#ct-auto-mode').val() || settings.autoMode;
    settings.profile = $('#ct-profile').val() || '';
    settings.customKey = $('#ct-key').val() || '';
    
    extension_settings[extName] = settings;
    stContext.saveSettingsDebounced();
    translationCache = {}; 
}

// 💡 중첩 태그 청소 로직 (사진 15055.jpg 방어)
function cleanResult(text) {
    if (!text) return "";
    return text.replace(/\[Alternative to:.*?\]/gi, "")
               .replace(/\[Note:.*?\]/gi, "")
               .replace(/\[CRITICAL:.*?\]/gi, "")
               .replace(/\[Different phrasing than:.*?\]/gi, "")
               .replace(/\*\*.*\*\*/g, "") // 마크다운 설명충 방어
               .trim();
}

/**
 * 핵심 번역 로직
 */
async function fetchTranslation(text, isInput = false, previousTranslation = null) {
    if (!text || text.trim() === "") return text;
    const cacheKey = `${settings.targetLang}_${isInput ? 'toEn' : 'toTarget'}_${text}`;
    
    // 💡 깜찍한 알림 (명세서 복구)
    if (!previousTranslation && translationCache[cacheKey]) {
        toastr.info("🐱 캐시 사용: 토큰을 아꼈습니다!");
        return translationCache[cacheKey];
    }

    const targetLang = isInput ? "English" : settings.targetLang;
    
    // 💡 사전충 완벽 방어 프롬프트 (사진 15170.jpg 방어)
    const basePrompt = isInput 
        ? "You are a raw text translator. Output ONLY the translated English text. NO explanations. NO dictionary definitions. NO introductory phrases. Just give the exact translation." 
        : settings.prompt.replace('{{language}}', targetLang);

    const cleanedPrev = cleanResult(previousTranslation);
    const variationPrompt = cleanedPrev ? `\n\n[CRITICAL RULE: Provide a completely different translation than: "${cleanedPrev}". No notes.]` : "";
    const promptWithText = `${basePrompt}${variationPrompt}\n\n${text}`;

    try {
        let result = "";
        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, [{ role: "user", content: promptWithText }], 4096);
            result = typeof response === 'string' ? response : (response.content || "");
        } 
        else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) { toastr.error("🐱 API 키가 없습니다!"); return text; }
            let modelName = settings.directModel.startsWith('models/') ? settings.directModel : `models/${settings.directModel}`;
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: promptWithText }] }],
                    generationConfig: { temperature: 0.3 }, // 헛소리 방지 온도 하향
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
            
            // 💡 구글 검열 알림 (명세서 복구)
            if (data.promptFeedback && data.promptFeedback.blockReason) {
                toastr.warning("🐱 구글 검열: 수위가 너무 높아 번역이 거부되었습니다.");
                return "[번역 거부됨]";
            }
            if (data.error) throw new Error(data.error.message);
            result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        }

        // 제미나이 리스트 출력 강제 방어
        if (isInput && result.includes('* "')) {
            const match = result.match(/\*\s*"([^"]+)"/);
            if (match) result = match[1];
        }

        result = cleanResult(result);
        if (result && result !== text) translationCache[cacheKey] = result;
        return result || text;
    } catch (e) {
        toastr.error(`🐱 앗, 에러 발생: ${e.message}`);
        return text;
    }
}

/**
 * 💡 메시지 번역 실행 (사진 15076.jpg 대응)
 */
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

/**
 * 💡 채팅창 내 모든 메시지에 아이콘 강제 자동 주입 (터치 불필요)
 */
function injectMessageButtons() {
    $('.mes:not(:has(.cat-btn-group))').each(function() {
        const msgId = $(this).attr('mesid');
        if (!msgId) return;
        
        const isUser = $(this).hasClass('mes_user');
        const group = $('<div class="cat-btn-group" style="display:inline-flex; gap:10px; margin-left:10px; align-items:center;"><span class="cat-mes-trans-btn" style="cursor:pointer; font-size:1.4em;"><span class="cat-emoji-icon">🐱</span></span><span class="cat-mes-revert-btn fa-solid fa-rotate-left" style="cursor:pointer; color:#ffb4a2; font-size:1em;"></span></div>');
        
        $(this).find('.name_text').append(group);
        
        group.find('.cat-mes-trans-btn').on('click', (e) => { 
            e.stopPropagation(); 
            processMessage(msgId, isUser); 
        });
        group.find('.cat-mes-revert-btn').on('click', (e) => { 
            e.stopPropagation(); 
            revertMessage(msgId); 
        });
    });
}

/**
 * 💡 입력창 버튼 강제 주입 및 스핀 유지 (사진 1772602221650.jpeg 대응)
 */
function injectInputButtons() {
    const sendBut = $('#send_but:visible');
    const stopBut = $('#interrupt_but:visible');
    const target = sendBut.length ? sendBut : (stopBut.length ? stopBut : null);
    
    if (!target || target.length === 0) return;

    const existingBtn = target.prev('#cat-input-btn');
    if (existingBtn.length > 0) {
        const icon = existingBtn.find('.cat-emoji-icon');
        if (isTranslatingInput && !icon.hasClass('cat-spin-anim')) icon.addClass('cat-spin-anim');
        if (!isTranslatingInput && icon.hasClass('cat-spin-anim')) icon.removeClass('cat-spin-anim');
        return; 
    }

    $('#cat-input-btn, #cat-input-revert-btn').remove();

    const catBtn = $('<div id="cat-input-btn" title="번역" style="cursor:pointer; margin-right:2px; display:inline-flex; align-items:center; font-size:1.3em;"><span class="cat-emoji-icon">🐱</span></div>');
    const revertBtn = $('<div id="cat-input-revert-btn" class="fa-solid fa-rotate-left" title="복구" style="cursor:pointer; margin-right:4px; color:#ffb4a2; font-size:1.1em; opacity:0.6;"></div>');
    
    if (isTranslatingInput) catBtn.find('.cat-emoji-icon').addClass('cat-spin-anim');

    target.before(catBtn).before(revertBtn);
    
    catBtn.on('click', async (e) => {
        e.preventDefault();
        if (isTranslatingInput) return; 
        
        const area = $('#send_textarea');
        if (!area.val()) return;

        isTranslatingInput = true; 
        catBtn.find('.cat-emoji-icon').addClass('cat-spin-anim');
        
        try {
            const isRetry = (area.val() === textAreaTranslated);
            if (!isRetry) textAreaOriginal = area.val();
            const trans = await fetchTranslation(textAreaOriginal, true, (isRetry ? textAreaTranslated : null));
            if (trans) { 
                textAreaTranslated = trans; 
                area.val(trans).trigger('input'); 
            }
        } finally {
            setTimeout(() => {
                isTranslatingInput = false; 
                $('#cat-input-btn .cat-emoji-icon').removeClass('cat-spin-anim');
            }, 300);
        }
    });

    revertBtn.on('click', (e) => { 
        e.preventDefault(); 
        if (textAreaOriginal) $('#send_textarea').val(textAreaOriginal).trigger('input'); 
    });
}

function setupUI() {
    injectInputButtons();
    injectMessageButtons();

    if (!$('#cat-trans-container').length) {
        let profileOptions = '';
        (stContext.extensionSettings?.connectionManager?.profiles || []).forEach(p => { profileOptions += `<option value="${p.id}">${p.name}</option>`; });
        
        // 💡 11개 국어 풀 리스트 복구 (사진 15051.jpg, 15146.jpg 대응)
        const uiHtml = `
            <div id="cat-trans-container" class="inline-drawer">
                <div class="inline-drawer-header interactable" tabindex="0">
                    <div class="inline-drawer-title">🐱 <span>트랜스레이터</span></div>
                    <div class="inline-drawer-toggle fa-solid fa-chevron-down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none; padding: 10px;">
                    <div class="cat-setting-row"><label>연결 프로필</label><select id="ct-profile" class="text_pole"><option value="">⚡ 직접 연결 모드</option>${profileOptions}</select></div>
                    <div id="direct-mode-settings" style="display: ${settings.profile === '' ? 'block' : 'none'};">
                        <div class="cat-setting-row"><label>API Key</label><input type="password" id="ct-key" class="text_pole" value="${settings.customKey}"></div>
                        <div class="cat-setting-row"><label>모델</label><select id="ct-model" class="text_pole">
                            <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                            <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                            <option value="gemini-2.0-pro-exp-02-05">Gemini 2.0 Pro Exp</option>
                        </select></div>
                    </div>
                    <div class="cat-setting-row"><label>자동 모드</label><select id="ct-auto-mode" class="text_pole"><option value="none">꺼짐</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                    <div class="cat-setting-row"><label>목표 언어</label><select id="ct-lang" class="text_pole">
                        <option value="Korean">Korean</option><option value="English">English</option><option value="Japanese">Japanese</option>
                        <option value="Chinese (Simplified)">Chinese (Simplified)</option><option value="Chinese (Traditional)">Chinese (Traditional)</option>
                        <option value="Spanish">Spanish</option><option value="French">French</option><option value="German">German</option>
                        <option value="Russian">Russian</option><option value="Vietnamese">Vietnamese</option><option value="Thai">Thai</option>
                    </select></div>
                    <div class="cat-setting-row"><label>프롬프트</label><textarea id="ct-prompt" class="text_pole" rows="4">${settings.prompt}</textarea></div>
                    <button id="cat-save-btn" class="menu_button">설정 저장 🐱</button>
                    <div style="font-size: 0.7em; opacity: 0.3; text-align: center; margin-top: 5px;">v8.5.0 Masterpiece Build</div>
                </div>
            </div>`;
        $('#extensions_settings').append(uiHtml);
        
        $('#cat-trans-container .inline-drawer-header').on('click', function() { 
            $(this).next('.inline-drawer-content').slideToggle(200); 
            $(this).find('.inline-drawer-toggle').toggleClass('fa-rotate-180'); 
        });
        
        // 💡 귀여운 저장 알림
        $('#cat-save-btn').on('click', function() { 
            saveSettings(); 
            toastr.success("🐱 모든 설정과 언어가 꼼꼼하게 저장되었습니다!"); 
        });
        
        $('#ct-profile').val(settings.profile).on('change', function() { settings.profile = $(this).val(); $('#direct-mode-settings').toggle(settings.profile === ''); saveSettings(); });
        $('#ct-key').on('input', function() { settings.customKey = $(this).val(); });
        $('#ct-model').val(settings.directModel).on('change', function() { settings.directModel = $(this).val(); saveSettings(); });
        $('#ct-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
        $('#ct-lang').val(settings.targetLang).on('change', function() { settings.targetLang = $(this).val(); saveSettings(); });
    }
}

jQuery(() => {
    setupUI();
    
    // 💡 0.25초마다 모든 위치(입력창, 채팅 말풍선)에 아이콘 강제 고정
    setInterval(() => {
        injectInputButtons();
        injectMessageButtons();
    }, 250);

    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, (d) => processMessage(typeof d === 'object' ? d.messageId : d, false));
    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, (d) => processMessage(typeof d === 'object' ? d.messageId : d, true));
});
