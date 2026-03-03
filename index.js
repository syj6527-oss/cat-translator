import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';

const extName = "cat-translator";
const stContext = getContext();

const defaultSettings = {
    profile: '', customKey: '', directModel: 'gemini-1.5-flash',
    autoMode: 'none', targetLang: 'Korean',
    prompt: 'Translate the following text into {{language}}. You are strictly required to translate EVERYTHING including contents inside code blocks (```). \n\nCRITICAL RULE: Output EXACTLY and ONLY the translated text. ABSOLUTELY NO explanations, dictionary definitions, nuances, or conversational filler. Even if the input is a single short word, output ONLY the translated word.',
    filterCodeBlock: true, maxTokens: 0
};
let settings = extension_settings[extName] || defaultSettings;

let textAreaOriginal = ""; let textAreaTranslated = "";

function saveSettings() {
    extension_settings[extName] = settings;
    stContext.saveSettingsDebounced();
}

async function fetchTranslation(text, isInput = false, previousTranslation = null) {
    const targetLang = isInput ? "English" : settings.targetLang;
    const basePrompt = isInput 
        ? "Translate the following text to English. \n\nCRITICAL REQUIREMENT: Output EXACTLY and ONLY the translated text. ABSOLUTELY NO explanations." 
        : settings.prompt.replace('{{language}}', targetLang);
    const variationPrompt = previousTranslation ? `\n\n[CRITICAL: Provide a DIFFERENT phrasing than: "${previousTranslation}"]` : "";
    const promptWithText = `${basePrompt}${variationPrompt}\n\n${text}`;

    try {
        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, [{ role: "user", content: promptWithText }], 4096);
            return typeof response === 'string' ? response : (response.content || "");
        } else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) return text;
            const model = settings.directModel.replace('models/', '');
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: promptWithText }] }] })
            });
            const data = await response.json();
            return data.candidates[0].content.parts[0].text.trim();
        }
    } catch (e) { return text; }
}

async function processMessage(id, isInput = false) {
    const msgId = parseInt(id, 10); 
    const msg = stContext.chat[msgId];
    if (!msg) return;

    const mesBlock = $(`.mes[mesid="${msgId}"]`);
    mesBlock.find('.cat-mes-trans-btn').addClass('cat-spin');

    let textToTranslate = isInput ? (msg.extra?.original_mes || msg.mes) : msg.mes;
    const translated = await fetchTranslation(textToTranslate, isInput, isInput ? msg.mes : msg.extra?.display_text);
    
    if (translated && translated !== textToTranslate) {
        if (!msg.extra) msg.extra = {};
        if (isInput) { msg.extra.original_mes = textToTranslate; msg.mes = translated; } 
        else { msg.extra.display_text = translated; }
        stContext.updateMessageBlock(msgId, msg); 
    }
    mesBlock.find('.cat-mes-trans-btn').removeClass('cat-spin');
}

function revertMessage(id) {
    const msgId = parseInt(id, 10);
    const msg = stContext.chat[msgId];
    if (!msg) return;
    if (msg.extra?.display_text) delete msg.extra.display_text;
    if (msg.extra?.original_mes) { msg.mes = msg.extra.original_mes; delete msg.extra.original_mes; }
    stContext.updateMessageBlock(msgId, msg);
}

function setupUI() {
    // 💡 짭의 잔해를 무시하는 완벽한 새 ID들!
    if (!$('#cat-input-btn').length) {
        const catBtn = $('<div id="cat-input-btn" title="번역하기"><span class="custom-cat-icon"></span></div>');
        const revertBtn = $('<div id="cat-input-revert-btn" class="fa-solid fa-rotate-left" title="원문 되돌리기"></div>');
        $('#send_but').before(catBtn).before(revertBtn);
        
        catBtn.on('click', async () => {
            const area = $('#send_textarea');
            if (area.val()) {
                catBtn.addClass('cat-spin');
                if (area.val() !== textAreaTranslated) textAreaOriginal = area.val();
                const trans = await fetchTranslation(textAreaOriginal, true, textAreaTranslated);
                if (trans) { textAreaTranslated = trans; area.val(trans).trigger('input'); }
                catBtn.removeClass('cat-spin');
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
                    <div class="inline-drawer-title" style="display:flex; align-items:center; gap:10px;">
                        <span class="custom-cat-icon" style="opacity:1;"></span>
                        <span>🐱고양이 번역기</span>
                    </div>
                    <div class="inline-drawer-toggle fa-solid fa-chevron-down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <div class="cat-setting-row"><label>Connection Profile</label><select id="ct-profile" class="text_pole"><option value="">⚡ 직접 연결</option>${profileOptions}</select></div>
                    <div class="cat-setting-row"><label>Auto Mode</label><select id="ct-auto-mode" class="text_pole"><option value="none">사용 안함</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                </div>
            </div>`;
        $('#extensions_settings').append(uiHtml);
        $('#cat-trans-container .inline-drawer-header').on('click', function() { $(this).siblings('.inline-drawer-content').slideToggle(200); });
        $('#ct-profile').val(settings.profile).on('change', function() { settings.profile = $(this).val(); saveSettings(); });
        $('#ct-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
    }
}

jQuery(() => {
    setupUI();
    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, (d) => { if(['output', 'both'].includes(settings.autoMode)) processMessage(typeof d === 'object' ? d.messageId : d, false); });
    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, (d) => { if(['input', 'both'].includes(settings.autoMode)) processMessage(typeof d === 'object' ? d.messageId : d, true); });
    
    $(document).on('mouseenter touchstart', '.mes', function() {
        if (!$(this).find('.cat-btn-group').length) {
            const btnGroup = $('<div class="cat-btn-group"></div>');
            const transBtn = $('<div class="cat-mes-trans-btn" title="번역"><span class="custom-cat-icon"></span></div>');
            const revertBtn = $('<div class="cat-mes-revert-btn fa-solid fa-rotate-left" title="되돌리기"></div>');
            btnGroup.append(transBtn).append(revertBtn);
            $(this).find('.name_text').append(btnGroup);
            transBtn.on('click', () => processMessage($(this).attr('mesid'), $(this).closest('.mes').hasClass('mes_user')));
            revertBtn.on('click', () => revertMessage($(this).attr('mesid')));
        }
    });
});
