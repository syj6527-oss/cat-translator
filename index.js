import { extension_settings } from '../../../extensions.js';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';

const extName = "st-magic-translator-pro";
const stContext = SillyTavern.getContext();

const defaultSettings = {
    profile: '', 
    customKey: '',
    directModel: 'gemini-1.5-flash',
    autoMode: 'none',
    targetLang: 'Korean',
    prompt: 'Translate the following text into {{language}}. You are strictly required to translate EVERYTHING. This includes all contents, keys, and values inside code blocks (```), YAML, status windows, blockquotes, and HTML tags. Preserve all original markdown formatting and tags exactly.\n\nCRITICAL RULE: Output ONLY the direct translation. NEVER provide explanations, dictionary definitions, nuances, or multiple options. Even if the input is a single short word, output ONLY the translated word. No introductory or concluding remarks.',
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
        ? "Translate the following text to English. \n\nCRITICAL REQUIREMENT: Output EXACTLY and ONLY the translated text. ABSOLUTELY NO explanations, dictionary definitions, nuances, or conversational filler. If the input is a single word, output ONLY the translated word without any extra text." 
        : settings.prompt.replace('{{language}}', targetLang);

    const variationPrompt = previousTranslation 
        ? `\n\n[CRITICAL INSTRUCTION: The user rejected your previous translation ("${previousTranslation}"). You MUST provide a DIFFERENT phrasing, synonym, or alternative translation this time. Do not repeat the previous translation.]` 
        : "";

    const promptWithText = `${basePrompt}${variationPrompt}\n\n${text}`;
    const maxT = parseInt(settings.maxTokens) > 0 ? parseInt(settings.maxTokens) : null; 

    try {
        let result = "";

        if (settings.profile && stContext.ConnectionManagerRequestService) {
            const messages = [{ role: "user", content: promptWithText }];
            const response = await stContext.ConnectionManagerRequestService.sendRequest(settings.profile, messages, maxT || 4096);
            if (!response) throw new Error("응답이 비어있습니다.");
            result = typeof response === 'string' ? response : (response.content || "");
        } else {
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) { toastr.error("API 키가 없습니다."); return text; }
            
            const model = settings.directModel.replace('models/', '');
            const body = {
                contents: [{ role: "user", parts: [{ text: promptWithText }] }],
                generationConfig: { temperature: 0.4 } 
            };
            if (maxT) body.generationConfig.maxOutputTokens = maxT;

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            if (!data.candidates || !data.candidates[0].content) throw new Error("빈 응답 반환됨.");
            
            result = data.candidates[0].content.parts[0].text.trim();
        }

        if (settings.filterCodeBlock && result) {
            let trimmed = result.trim();
            if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
                const firstNewLine = trimmed.indexOf('\n');
                const lastBackticks = trimmed.lastIndexOf('```');
                if (firstNewLine !== -1 && lastBackticks > firstNewLine) {
                    result = trimmed.substring(firstNewLine + 1, lastBackticks).trim();
                }
            }
        }

        return result || text;
    } catch (e) {
        console.error("[Flash Translator Error]", e);
        toastr.error("번역 실패: " + e.message);
        return text;
    }
}

async function processMessage(id, isInput = false) {
    const msgId = parseInt(id, 10); 
    const msg = stContext.chat[msgId];
    if (!msg) return;

    const mesBlock = $(`.mes[mesid="${msgId}"]`);
    const btnContainer = mesBlock.find('.flash-mes-trans-btn');
    btnContainer.addClass('fa-spin');

    let textToTranslate = msg.mes;
    let prevTrans = null;

    if (isInput) {
        if (msg.extra && msg.extra.original_mes) {
            textToTranslate = msg.extra.original_mes;
            prevTrans = msg.mes; 
        }
    } else {
        if (msg.extra && msg.extra.display_text) {
            prevTrans = msg.extra.display_text;
        }
    }

    const translated = await fetchTranslation(textToTranslate, isInput, prevTrans);
    
    if (translated && translated !== textToTranslate && translated !== prevTrans) {
        if (isInput) {
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.original_mes) msg.extra.original_mes = msg.mes; 
            msg.mes = translated; 
        } else {
            if (!msg.extra) msg.extra = {};
            msg.extra.display_text = translated; 
        }
        stContext.updateMessageBlock(msgId, msg); 
    }
    
    btnContainer.removeClass('fa-spin');
}

function revertMessage(id) {
    const msgId = parseInt(id, 10);
    const msg = stContext.chat[msgId];
    if (!msg) return;

    let changed = false;

    if (msg.extra && msg.extra.display_text) {
        delete msg.extra.display_text;
        changed = true;
    }
    if (msg.extra && msg.extra.original_mes) {
        msg.mes = msg.extra.original_mes;
        delete msg.extra.original_mes;
        changed = true;
    }

    if (changed) stContext.updateMessageBlock(msgId, msg);
}

function setupUI() {
    if (!$('#flash-input-cat-btn').length) {
        const catBtn = $('<div id="flash-input-cat-btn" title="입력창 수동 번역 (계속 누르면 바뀜)"><span class="custom-cat-icon"></span></div>');
        const revertBtn = $('<div id="flash-input-revert-icon" class="fa-solid fa-rotate-left" title="원본으로 되돌리기"></div>');
        
        $('#send_but').before(catBtn).before(revertBtn);
        
        catBtn.on('click', async () => {
            const area = $('#send_textarea');
            const currentVal = area.val();
            
            if (currentVal) {
                catBtn.addClass('fa-spin');
                
                let textToTranslate = currentVal;
                let prev = null;
                
                if (currentVal === textAreaTranslated) {
                    textToTranslate = textAreaOriginal; 
                    prev = textAreaTranslated;          
                } else {
                    textAreaOriginal = currentVal;      
                }

                const trans = await fetchTranslation(textToTranslate, true, prev);
                
                if (trans && trans !== textToTranslate && trans !== prev) {
                    textAreaTranslated = trans;
                    area.val(trans).trigger('input');
                }
                catBtn.removeClass('fa-spin');
            }
        });

        revertBtn.on('click', () => {
            const area = $('#send_textarea');
            if (textAreaOriginal && area.val() !== textAreaOriginal) {
                area.val(textAreaOriginal).trigger('input');
                textAreaTranslated = ""; 
            }
        });
    }

    if (!$('#flash-trans-container').length) {
        let profileOptions = '';
        const profiles = stContext.extensionSettings?.connectionManager?.profiles || [];
        profiles.forEach(p => { profileOptions += `<option value="${p.id}">${p.name}</option>`; });

        const uiHtml = `
            <div id="flash-trans-container" class="inline-drawer">
                <div class="inline-drawer-header interactable" tabindex="0">
                    <div class="inline-drawer-title" style="display:flex; align-items:center; gap:10px;">
                        <span class="custom-cat-icon"></span>
                        <span>🐱트랜스레이터</span>
                    </div>
                    <div class="inline-drawer-toggle fa-solid fa-chevron-down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <div class="flash-setting-row">
                        <label>Connection Profile (프리셋 연동)</label>
                        <select id="ft-profile" class="text_pole">
                            <option value="">⚡ 직접 연결 모드 (아래 설정 사용)</option>
                            ${profileOptions}
                        </select>
                    </div>
                    <div id="direct-mode-settings" style="border-left: 2px solid #4a90e2; padding-left: 10px; margin-bottom: 15px; display: ${settings.profile === '' ? 'block' : 'none'};">
                        <div class="flash-setting-row">
                            <label>직접 연결: API Key (비우면 기본키 사용)</label>
                            <input type="password" id="ft-key" class="text_pole" placeholder="직접 입력 (선택사항)">
                        </div>
                        <div class="flash-setting-row" style="margin-bottom:0;">
                            <label>직접 연결: Flash Model</label>
                            <select id="ft-model" class="text_pole">
                                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                                <option value="gemini-1.5-flash-8b">Gemini 1.5 Flash 8B</option>
                                <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash</option>
                            </select>
                        </div>
                    </div>
                    <div class="flash-setting-row" style="display:flex; gap:10px;">
                        <div style="flex:1;">
                            <label>Auto Mode</label>
                            <select id="ft-auto-mode" class="text_pole">
                                <option value="none">사용 안함</option>
                                <option value="input">입력만</option>
                                <option value="output">출력만</option>
                                <option value="both">둘 다</option>
                            </select>
                        </div>
                        <div style="flex:1;">
                            <label>Target Language</label>
                            <select id="ft-lang" class="text_pole">
                                <option value="Korean">Korean</option>
                                <option value="English">English</option>
                                <option value="Japanese">Japanese</option>
                            </select>
                        </div>
                    </div>
                    <div class="flash-setting-row">
                        <label>번역 프롬프트</label>
                        <textarea id="ft-prompt" class="text_pole" rows="6"></textarea>
                        <label style="display:flex; align-items:center; gap:5px; margin-top:8px; cursor:pointer; font-weight:normal; font-size:0.9em; opacity:0.8;">
                            <input type="checkbox" id="ft-filter-code"> Filter Code Block (\`\`\`)
                        </label>
                    </div>
                    <div class="flash-setting-row">
                        <label>Max Tokens (0 = 무한)</label>
                        <input type="number" id="ft-tokens" class="text_pole" min="0" style="width:50%;">
                    </div>
                </div>
            </div>
        `;
        $('#extensions_settings').append(uiHtml);

        $('#flash-trans-container .inline-drawer-header').on('click', function() {
            $(this).siblings('.inline-drawer-content').slideToggle(200);
            $(this).find('.inline-drawer-toggle').toggleClass('fa-chevron-down fa-chevron-up');
        });

        $('#ft-profile').val(settings.profile).on('change', function() { 
            settings.profile = $(this).val(); 
            if(settings.profile === '') $('#direct-mode-settings').slideDown();
            else $('#direct-mode-settings').slideUp();
            saveSettings(); 
        });
        $('#ft-key').val(settings.customKey).on('input', function() { settings.customKey = $(this).val(); saveSettings(); });
        $('#ft-model').val(settings.directModel).on('change', function() { settings.directModel = $(this).val(); saveSettings(); });
        $('#ft-auto-mode').val(settings.autoMode).on('change', function() { settings.autoMode = $(this).val(); saveSettings(); });
        $('#ft-lang').val(settings.targetLang).on('change', function() { settings.targetLang = $(this).val(); saveSettings(); });
        $('#ft-prompt').val(settings.prompt).on('input', function() { settings.prompt = $(this).val(); saveSettings(); });
        $('#ft-filter-code').prop('checked', settings.filterCodeBlock).on('change', function() { settings.filterCodeBlock = $(this).is(':checked'); saveSettings(); });
        $('#ft-tokens').val(settings.maxTokens).on('input', function() { settings.maxTokens = $(this).val(); saveSettings(); });
    }
}

jQuery(() => {
    setupUI();
    
    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, (d) => { 
        const msgId = typeof d === 'object' ? d.messageId : d;
        if(['output', 'both'].includes(settings.autoMode)) processMessage(msgId, false); 
    });

    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, (d) => { 
        const msgId = typeof d === 'object' ? d.messageId : d;
        if(['input', 'both'].includes(settings.autoMode)) processMessage(msgId, true); 
    });
    
    $(document).on('mouseenter touchstart', '.mes', function() {
        if (!$(this).find('.flash-btn-group').length) {
            const btnGroup = $('<div class="flash-btn-group"></div>');
            const transBtn = $('<div class="flash-mes-trans-btn" title="고양이 번역기 (여러번 누르면 바뀜)"><span class="custom-cat-icon"></span></div>');
            const revertBtn = $('<div class="flash-mes-revert-btn fa-solid fa-rotate-left" title="원본으로 되돌리기"></div>');

            btnGroup.append(transBtn).append(revertBtn);
            $(this).find('.name_text').append(btnGroup);

            transBtn.on('click', () => {
                const isUserInput = $(this).closest('.mes').hasClass('mes_user'); 
                processMessage($(this).attr('mesid'), isUserInput);
            });

            revertBtn.on('click', () => revertMessage($(this).attr('mesid')));
        }
    });
});
