import { extension_settings } from '../../../extensions.js';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';

// 💡 찌꺼기 없는 완전히 새로운 이름으로 회피!
const extName = "st-cat-translator-pro"; 
const stContext = SillyTavern.getContext();

const defaultSettings = {
    profile: '', 
    customKey: '',
    directModel: 'gemini-1.5-flash',
    autoMode: 'none',
    targetLang: 'Korean',
    prompt: 'Translate the following text into {{language}}. You are strictly required to translate EVERYTHING. Output EXACTLY and ONLY the translated text. No explanations.',
    filterCodeBlock: true,
    maxTokens: 0
};
let settings = extension_settings[extName] || defaultSettings;

let textAreaOriginal = "";
let textAreaTranslated = "";

function saveSettings() {
    extension_settings[extName] = settings;
    stContext.saveSettingsDebounced();
}

async function fetchTranslation(text, isInput = false, previousTranslation = null) {
    const targetLang = isInput ? "English" : settings.targetLang;
    const basePrompt = isInput 
        ? "Translate to English. Output ONLY the translated text." 
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
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: promptWithText }] }] })
            });
            const data = await response.json();
            return data.candidates[0].content.parts[0].text.trim() || text;
        }
    } catch (e) { return text; }
}

async function processMessage(id, isInput = false) {
    const msgId = parseInt(id, 10); 
    const msg = stContext.chat[msgId];
    if (!msg) return;

    const mesBlock = $(`.mes[mesid="${msgId}"]`);
    mesBlock.find('.flash-mes-trans-btn').addClass('fa-spin');

    let textToTranslate = isInput ? (msg.extra?.original_mes || msg.mes) : msg.mes;
    const translated = await fetchTranslation(textToTranslate, isInput, isInput ? msg.mes : msg.extra?.display_text);
    
    if (translated && translated !== textToTranslate) {
        if (!msg.extra) msg.extra = {};
        if (isInput) {
            msg.extra.original_mes = textToTranslate;
            msg.mes = translated; 
        } else {
            msg.extra.display_text = translated; 
        }
        stContext.updateMessageBlock(msgId, msg); 
    }
    mesBlock.find('.flash-mes-trans-btn').removeClass('fa-spin');
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
    if (!$('#flash-input-cat-btn').length) {
        const catBtn = $('<div id="flash-input-cat-btn" title="번역하기"><span class="custom-cat-icon"></span></div>');
        const revertBtn = $('<div id="flash-input-revert-icon" class="fa-solid fa-rotate-left" title="원문 되돌리기"></div>');
        $('#send_but').before(catBtn).before(revertBtn);
        
        catBtn.on('click', async () => {
            const area = $('#send_textarea');
            if (area.val()) {
                catBtn.addClass('fa-spin');
                if (area.val() !== textAreaTranslated) textAreaOriginal = area.val();
                const trans = await fetchTranslation(textAreaOriginal, true, textAreaTranslated);
                if (trans) { textAreaTranslated = trans; area.val(trans).trigger('input'); }
                catBtn.removeClass('fa-spin');
            }
        });
        revertBtn.on('click', () => { if (textAreaOriginal) $('#send_textarea').val(textAreaOriginal).trigger('input'); });
    }

    if (!$('#flash-trans-container').length) {
        let profileOptions = '';
        (stContext.extensionSettings?.connectionManager?.profiles || []).forEach(p => { profileOptions += `<option value="${p.id}">${p.name}</option>`; });
        const uiHtml = `
            <div id="flash-trans-container" class="inline-drawer">
                <div class="inline-drawer-header interactable" tabindex="0">
                    <div class="inline-drawer-title" style="display:flex; align-items:center; gap:10px;">
                        <span class="custom-cat-icon" style="opacity:1;"></span>
                        <span>🐱트랜스레이터</span>
                    </div>
                    <div class="inline-drawer-toggle fa-solid fa-chevron-down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <div class="flash-setting-row"><label>Connection Profile</label><select id="ft-profile" class="text_pole"><option value="">⚡ 직접 연결</option>${profileOptions}</select></div>
                    <div class="flash-setting-row"><label>Auto Mode</label><select id="ft-auto-mode" class="text_pole"><option value="none">사용 안함</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                </div>
            </div>`;
        $('#extensions_settings').append(uiHtml);
        $('#flash-trans-container .inline-drawer-header').on('click', function() { $(this).siblings('.inline-drawer-content').slideToggle(200); });
        $('#ft-profile').val(settings.profile).on('change', function() { settings.profile = $(this).val(); saveSettings(); });
        $('#ft-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
    }
}

jQuery(() => {
    setupUI();
    $(document).on('mouseenter touchstart', '.mes', function() {
        if (!$(this).find('.flash-btn-group').length) {
            const btnGroup = $('<div class="flash-btn-group"></div>');
            const transBtn = $('<div class="flash-mes-trans-btn" title="번역"><span class="custom-cat-icon"></span></div>');
            const revertBtn = $('<div class="flash-mes-revert-btn fa-solid fa-rotate-left" title="되돌리기"></div>');
            btnGroup.append(transBtn).append(revertBtn);
            $(this).find('.name_text').append(btnGroup);
            transBtn.on('click', () => processMessage($(this).attr('mesid'), $(this).closest('.mes').hasClass('mes_user')));
            revertBtn.on('click', () => revertMessage($(this).attr('mesid')));
        }
    });
});
