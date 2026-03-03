import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';

const extName = "cat-translator";
const stContext = getContext();

const defaultPrompt = 'You are a professional translator. Your goal is to translate EVERY piece of natural language text into {{language}}, NO MATTER WHERE IT IS LOCATED.\n\n[MANDATORY INSTRUCTIONS]\n1. Translate text inside code blocks (```), HTML comments (<!-- -->), and all tags (<memo>, <summary>, etc.).\n2. KEEP all structural tags and code syntax EXACTLY as they are.\n3. ONLY swap the English words for {{language}}.\n4. DO NOT skip any section.';

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

let textAreaOriginal = "";
let textAreaTranslated = "";

function saveSettings() {
    extension_settings[extName] = settings;
    stContext.saveSettingsDebounced();
}

async function fetchTranslation(text, isInput = false, previousTranslation = null) {
    const targetLang = isInput ? "English" : settings.targetLang;
    const basePrompt = isInput 
        ? "Translate the following text into natural English. Preserve all tags." 
        : settings.prompt.replace('{{language}}', targetLang);

    const variationPrompt = previousTranslation ? `\n\n[Note: Use a different phrasing than: "${previousTranslation}"]` : "";
    const promptWithText = `${basePrompt}${variationPrompt}\n\n${text}`;
    const maxT = parseInt(settings.maxTokens) > 0 ? parseInt(settings.maxTokens) : null; 

    try {
        let result = "";
        
        // 1. 프리셋(Connection Profile) 사용 모드
        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const messages = [{ role: "user", content: promptWithText }];
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, messages, maxT || 4096);
            if (!response) throw new Error("프리셋 응답이 비어있습니다. 연결 설정을 확인하세요.");
            result = typeof response === 'string' ? response : (response.content || "");
        } 
        // 2. 직접 API 연결 모드
        else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) {
                toastr.error("🐱: API 키가 없습니다! 실리태번 설정(열쇠 아이콘)에서 Google MakerSuite 키를 넣거나 확장 설정에 직접 입력해 주세요.");
                return text;
            }
            
            // 모델명 정규화 (앞에 models/ 가 붙어야 안정적임)
            let modelName = settings.directModel;
            if (!modelName.startsWith('models/')) modelName = `models/${modelName}`;
            
            const body = {
                contents: [{ role: "user", parts: [{ text: promptWithText }] }],
                generationConfig: { temperature: 0.2 },
                safetySettings: [
                    { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
                    { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
                    { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
                    { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" },
                    { "category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE" }
                ]
            };
            if (maxT) body.generationConfig.maxOutputTokens = maxT;

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await response.json();
            
            if (data.error) {
                const errMsg = data.error.message || "알 수 없는 API 오류";
                toastr.error(`🐱 번역 에러: ${errMsg}`);
                throw new Error(errMsg);
            }
            
            if (data.promptFeedback?.blockReason) {
                toastr.warning(`🐱 구글이 번역을 거부했습니다: ${data.promptFeedback.blockReason}`);
                return `[번역 거부: ${data.promptFeedback.blockReason}]`;
            }
            
            result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        }

        if (settings.filterCodeBlock && result) {
            let trimmed = result.trim();
            if (trimmed.startsWith("```") && trimmed.endsWith("```") && !text.trim().startsWith("```")) {
                const lines = trimmed.split('\n');
                if (lines.length > 2) result = lines.slice(1, -1).join('\n').trim();
            }
        }
        return result || text;
    } catch (e) {
        console.error("[Cat Translator Error]", e);
        return text;
    }
}

async function processMessage(id, isInput = false) {
    const msgId = parseInt(id, 10); 
    const msg = stContext.chat[msgId];
    if (!msg) return;
    const mesBlock = $(`.mes[mesid="${msgId}"]`);
    const btnIcon = mesBlock.find('.cat-emoji-icon');
    btnIcon.addClass('cat-spin-anim');
    let textToTranslate = isInput ? (msg.extra?.original_mes || msg.mes) : msg.mes;
    const translated = await fetchTranslation(textToTranslate, isInput, isInput ? msg.mes : msg.extra?.display_text);
    if (translated && translated !== textToTranslate) {
        if (!msg.extra) msg.extra = {};
        if (isInput) { msg.extra.original_mes = textToTranslate; msg.mes = translated; }
        else { msg.extra.display_text = translated; }
        stContext.updateMessageBlock(msgId, msg); 
    }
    btnIcon.removeClass('cat-spin-anim');
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

function setupUI() {
    if (!$('#cat-input-btn').length) {
        const catBtn = $('<div id="cat-input-btn" title="고양이 번역" style="cursor:pointer; margin-right:4px; display:inline-flex; align-items:center; font-size:1.3em;"><span class="cat-emoji-icon" style="display:inline-block; line-height:1;">🐱</span></div>');
        const revertBtn = $('<div id="cat-input-revert-btn" class="fa-solid fa-rotate-left" title="원본 복구" style="cursor:pointer; margin-right:4px; color:#ffb4a2; font-size:1.1em; opacity:0.6; transition:all 0.2s; display:inline-flex; align-items:center;"></div>');
        $('#send_but').before(catBtn).before(revertBtn);
        catBtn.on('click', async () => {
            const area = $('#send_textarea');
            if (area.val()) {
                catBtn.find('.cat-emoji-icon').addClass('cat-spin-anim');
                if (area.val() !== textAreaTranslated) textAreaOriginal = area.val();
                const trans = await fetchTranslation(textAreaOriginal, true, textAreaTranslated);
                if (trans) { textAreaTranslated = trans; area.val(trans).trigger('input'); }
                catBtn.find('.cat-emoji-icon').removeClass('cat-spin-anim');
            }
        });
        revertBtn.on('click', () => { if (textAreaOriginal) $('#send_textarea').val(textAreaOriginal).trigger('input'); });
    }

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
                        <div class="cat-setting-row"><label>직접 연결: API Key</label><input type="password" id="ct-key" class="text_pole" placeholder="직접 입력"></div>
                        <div class="cat-setting-row"><label>직접 연결: Model</label><select id="ct-model" class="text_pole"><option value="gemini-1.5-flash">Gemini 1.5 Flash</option><option value="gemini-1.5-flash-8b">Gemini 1.5 Flash 8B</option><option value="gemini-2.0-flash-exp">Gemini 2.0 Flash</option></select></div>
                    </div>
                    <div class="cat-setting-row"><label>Auto Mode</label><select id="ct-auto-mode" class="text_pole"><option value="none">사용 안함</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                    <div class="cat-setting-row"><label>Target Language</label><select id="ct-lang" class="text_pole"><option value="Korean">Korean</option><option value="English">English</option><option value="Japanese">Japanese</option><option value="Spanish">Spanish</option><option value="French">French</option><option value="German">German</option><option value="Russian">Russian</option><option value="Vietnamese">Vietnamese</option></select></div>
                    <div class="cat-setting-row"><label>번역 프롬프트</label><textarea id="ct-prompt" class="text_pole" rows="4"></textarea>
                        <label style="display:flex; align-items:center; gap:5px; margin-top:8px; cursor:pointer; font-weight:normal; font-size:0.9em; opacity:0.8;"><input type="checkbox" id="ct-filter-code"> Filter Code Block</label>
                    </div>
                    <div class="cat-setting-row"><label>Max Tokens</label><input type="number" id="ct-tokens" class="text_pole" min="0"></div>
                    <div class="cat-setting-row" style="margin-top: 15px;"><button id="cat-save-btn" class="menu_button">설정 저장 🐱</button></div>
                </div>
            </div>
        `;
        $('#extensions_settings').append(uiHtml);
        $('#cat-trans-container .inline-drawer-header').off('click').on('click', function(e) { e.stopPropagation(); const $content = $(this).next('.inline-drawer-content'); const $toggle = $(this).find('.inline-drawer-toggle'); $content.stop().slideToggle(200); $toggle.toggleClass('fa-rotate-180'); });
        $('#cat-save-btn').on('click', function() { saveSettings(); toastr.success("🐱 설정이 저장되었습니다! 🐾"); });
        $('#ct-profile').val(settings.profile).on('change', function() { settings.profile = $(this).val(); if(settings.profile === '') $('#direct-mode-settings').slideDown(); else $('#direct-mode-settings').slideUp(); saveSettings(); });
        $('#ct-key').val(settings.customKey).on('input', function() { settings.customKey = $(this).val(); saveSettings(); });
        $('#ct-model').val(settings.directModel).on('change', function() { settings.directModel = $(this).val(); saveSettings(); });
        $('#ct-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
        $('#ct-lang').val(settings.targetLang).on('change', function() { settings.targetLang = $(this).val(); saveSettings(); });
        $('#ct-prompt').val(settings.prompt).on('input', function() { settings.prompt = $(this).val(); saveSettings(); });
        $('#ct-filter-code').prop('checked', settings.filterCodeBlock).on('change', function() { settings.filterCodeBlock = $(this).is(':checked'); saveSettings(); });
        $('#ct-tokens').val(settings.maxTokens).on('input', function() { settings.maxTokens = $(this).val(); saveSettings(); });
    }
}

jQuery(() => {
    setupUI();
    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, (d) => { const msgId = typeof d === 'object' ? d.messageId : d; if(['output', 'both'].includes(settings.autoMode)) processMessage(msgId, false); });
    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, (d) => { const msgId = typeof d === 'object' ? d.messageId : d; if(['input', 'both'].includes(settings.autoMode)) processMessage(msgId, true); });
    $(document).on('mouseenter touchstart', '.mes', function() {
        if (!$(this).find('.cat-btn-group').length) {
            const btnGroup = $('<div class="cat-btn-group" style="display:inline-flex; gap:12px; margin-left:10px; align-items:center;"></div>');
            const transBtn = $('<div class="cat-mes-trans-btn" title="번역" style="cursor:pointer; opacity:0.6; font-size:1.6em; line-height:1;"><span class="cat-emoji-icon" style="display:inline-block;">🐱</span></div>');
            const revertBtn = $('<div class="cat-mes-revert-btn fa-solid fa-rotate-left" title="복구" style="cursor:pointer; color:#ffb4a2; opacity:0.6; font-size:1.1em; margin-bottom: 2px;"></div>');
            btnGroup.append(transBtn).append(revertBtn);
            $(this).find('.name_text').append(btnGroup);
            transBtn.on('click', () => { processMessage($(this).attr('mesid'), $(this).closest('.mes').hasClass('mes_user')); });
            revertBtn.on('click', () => revertMessage($(this).attr('mesid')));
        }
    });
});
