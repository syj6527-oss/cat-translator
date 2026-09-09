// ============================================================
// 🐱 Translator v1.1.0 - ui.js
// ============================================================
import { CAT_BETA_VERSION, CAT_BUILD_CHANNEL, catNotify, catNotifyProgress, getThemeEmoji, getCompletionEmoji, getModelTheme, setTextareaValue, resolveInputTranslationDirection, resolveInputUserPrompt, normalizeInternalInputLanguage, shouldKeepInternalInputEnter, shouldRestoreInternalInputDraft, getInternalInputState, applyInternalInputState } from './utils.js';
import { getStats, clearAllCache, exportSettings, importSettings, getHistory, togglePin, deleteHistoryItem } from './cache.js';
import { fetchTranslation, gatherContextMessages, gatherInternalInputContextMessages, SYSTEM_SHIELD, STYLE_PRESETS, getLastDebugLog, getTranslationStats } from './translator.js';
import { suggestDictionarySource, normalizeContextRange } from './utils.js';

let bulkAbortController = null;
let isTranslatingInput = false;
let inputTranslationRequestId = 0;
let _settingsRef = null;  // 🚨 collectSettings에서 promptPresets/charPresetMap 접근용
let _suppressAutoSave = false;  // 🚨 프리셋 로드 중 autoSave/스타일핸들러 차단
let _autoSaveTimer = null;  // 🚨 모듈 스코프로 이동 (CHAT_CHANGED에서 접근 필요)
const _translatedEditSessions = new Map();
let _internalInputSendBusy = false;
let _internalInputSendBypass = false;

function getTranslatedEditKey(msgId) {
    const id = Number.parseInt(msgId, 10);
    return Number.isInteger(id) ? String(id) : null;
}

export function getTranslatedEditSession(msgId, expectedChatRef = null) {
    const key = getTranslatedEditKey(msgId);
    if (key === null) return null;
    const session = _translatedEditSessions.get(key) || null;
    if (session && expectedChatRef && session.chatRef !== expectedChatRef) return null;
    return session;
}

export function isTranslatedEditActive(msgId, expectedChatRef = null) {
    return !!getTranslatedEditSession(msgId, expectedChatRef);
}

export function markTranslatedEditSave(msgId, capturedText, expectedChatRef = null) {
    const session = getTranslatedEditSession(msgId, expectedChatRef);
    if (!session) return false;
    session.saveRequested = true;
    if (typeof capturedText === 'string') session.capturedText = capturedText;
    return true;
}

export function clearTranslatedEditSessions(expectedChatRef = null) {
    if (!expectedChatRef) {
        _translatedEditSessions.clear();
        return;
    }
    for (const [key, session] of _translatedEditSessions) {
        if (session.chatRef === expectedChatRef) _translatedEditSessions.delete(key);
    }
}

function beginTranslatedEditSession(msgId, chatRef, messageRef, swipeId, originalText, displayText) {
    const key = getTranslatedEditKey(msgId);
    if (key === null) return null;
    const session = {
        key,
        msgId: Number.parseInt(key, 10),
        chatRef,
        messageRef,
        swipeId,
        originalText,
        displayText,
        capturedText: null,
        saveRequested: false
    };
    _translatedEditSessions.set(key, session);
    return session;
}

function clearTranslatedEditSession(msgId, expectedSession = null) {
    const key = getTranslatedEditKey(msgId);
    if (key === null) return;
    if (expectedSession && _translatedEditSessions.get(key) !== expectedSession) return;
    _translatedEditSessions.delete(key);
}

function getTranslatedEditMessage(session) {
    const ctx = SillyTavern?.getContext?.();
    if (!ctx || ctx.chat !== session.chatRef) return null;
    const message = session.chatRef?.[session.msgId];
    if (!message || message.swipe_id !== session.swipeId) return null;
    const sourceStillMatches =
        message === session.messageRef ||
        message.extra?.original_mes === session.originalText ||
        message.mes === session.originalText ||
        (session.saveRequested &&
            typeof session.capturedText === 'string' &&
            message.mes === session.capturedText);
    return sourceStillMatches ? message : null;
}

export function abortBulkTranslation() {
    if (bulkAbortController && !bulkAbortController.signal.aborted) {
        bulkAbortController.abort();
    }
}

// 🚨 인풋 유실 방어: 번역 덮어쓰기 직전 입력을 항상 백업 (최근 10개)
const _catInputHistory = [];
function pushInputHistory(text) {
    if (!text || !text.trim()) return;
    if (_catInputHistory[_catInputHistory.length - 1] === text) return;
    _catInputHistory.push(text);
    if (_catInputHistory.length > 10) _catInputHistory.shift();
    console.log(`[CAT] 💾 인풋 히스토리 백업 (${_catInputHistory.length}개): ${text.substring(0, 40)}...`);
}

/** 프리셋 로드 시 autoSave 레이스 컨디션 방지용 */
export function setSuppressAutoSave(val) { _suppressAutoSave = val; }
/** 대기 중인 autoSave 타이머 취소 */
export function clearPendingAutoSave() { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }

export function setupSettingsPanel(settings, stContext, saveSettingsFn, restoreDefaultPromptSettingsFn = null) {
    _settingsRef = settings;  // 🚨 collectSettings에서 접근용
    const currentPanel = $('#cat-trans-container');
    if (currentPanel.length) {
        const currentVersion = String(currentPanel.attr('data-cat-version') || '');
        const controlsReady = currentPanel.find('#ct-internal-input, #ct-internal-input-lang').length === 2;
        if (currentVersion === CAT_BETA_VERSION && controlsReady) return true;
        currentPanel.remove();
    }

    // 정식판과 실험실판은 같은 설정/버튼 ID를 사용하므로 동시에 켜면 안전하지 않다.
    // 로드 순서와 무관하게 먼저 활성화된 실험실판이 있으면 정식판이 양보한다.
    if ($('#cat-trans-lab-container').length) {
        if (!$('#cat-trans-release-conflict').length) {
            $('#extensions_settings').append(`
                <div id="cat-trans-release-conflict" class="inline-drawer" data-cat-version="${CAT_BETA_VERSION}" style="padding:10px; border:1px solid #d88;">
                    <b>🐱 Cat Translator ${CAT_BETA_VERSION}</b><br>
                    <span style="font-size:0.88em;">실험실판이 함께 활성화되어 정식판을 중지했습니다. 실험실판을 끈 뒤 새로고침하세요.</span>
                </div>`);
        }
        catNotify('🐱 실험실판을 끈 뒤 새로고침해야 정식판 설정이 표시됩니다.', 'warning');
        console.warn(`[CAT ${CAT_BETA_VERSION}] 실험실판 설정 패널 충돌 감지 → 정식판 설정 초기화 중지`);
        return false;
    }
    $('#cat-trans-release-conflict').remove();

    let profileOptions = '<option value="">⚡ 직접 연결 모드</option>';
    (stContext.extensionSettings?.connectionManager?.profiles || []).forEach(p => { profileOptions += `<option value="${p.id}">${p.name}</option>`; });

    const languages = ['Korean', 'English', 'Chinese', 'Japanese', 'German', 'Russian', 'French'];
    const langOptions = languages.map(l => `<option value="${l}">${l}</option>`).join('');
    const styleOptions = Object.entries(STYLE_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    const statsData = getStats();
    
    const dictIcon = (settings.dictionary && settings.dictionary.trim()) ? '📬' : '📭';

    const html = `
    <div id="cat-trans-container" class="inline-drawer" data-cat-version="${CAT_BETA_VERSION}">
        <div id="cat-drawer-header" class="inline-drawer-header interactable" tabindex="0">
            <div class="inline-drawer-title"><span class="cat-beta-brand-emoji">🐱</span><span>Cat Translator <small style="opacity:0.6;">${CAT_BETA_VERSION}</small></span></div>
            <i id="cat-drawer-toggle" class="inline-drawer-toggle fa-fw fa-solid fa-circle-chevron-down inline-drawer-icon down interactable"></i>
        </div>
        <div id="cat-drawer-content" class="inline-drawer-content" style="display:none; padding:10px;">
            <div class="cat-setting-row"><label>연결 프로필</label><select id="ct-profile" class="text_pole">${profileOptions}</select></div>
            <div style="font-size:0.8em; opacity:0.65; margin:-2px 0 8px; line-height:1.45;">💡 번역용 프로필을 선택하면 그 프로필의 API·모델 설정을 사용하며, 아래 직접 연결 설정은 사용하지 않습니다.</div>
            <div id="ct-direct-toggle" class="cat-setting-row" style="cursor:pointer; opacity:0.7; font-size:0.85em; padding:4px 0;">
                <span id="ct-direct-arrow">▶</span> <span>직접 연결 설정 (고급)</span>
            </div>
            <div id="ct-direct-settings" style="display:none;">
                <div style="font-size:0.8em; opacity:0.65; margin-bottom:8px; padding:6px; border-radius:6px; background:var(--SmartThemeBlurTintColor, rgba(0,0,0,0.1)); line-height:1.45;">⚡ 위에서 <b>직접 연결 모드</b>를 선택한 경우에만 사용합니다. <a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--ca-accent);">Google AI Studio</a>에서 발급한 Gemini API Key(보통 AIza...)를 입력하세요. 키는 공유하거나 스크린샷에 노출하지 마세요.</div>
                <div class="cat-setting-row" style="position:relative;">
                    <label>API Key</label>
                    <input type="password" id="ct-key" class="text_pole" value="${settings.customKey}" style="padding-right:36px;">
                    <span id="ct-key-toggle" class="cat-paw-toggle" title="키 보기/숨기기">🐾</span>
                </div>
                <div class="cat-setting-row">
                    <label>모델</label>
                    <select id="ct-model" class="text_pole">
                        <optgroup label="🐱 고양이 라인 (Flash)"><option value="gemini-3.7-flash">3.7 Flash</option><option value="gemini-3.5-flash">3.5 Flash</option><option value="gemini-2.5-flash">2.5 Flash (10/16 종료 예정)</option></optgroup>
                        <optgroup label="🐯 호랑이 라인 (Pro)"><option value="gemini-2.5-pro">2.5 Pro</option><option value="gemini-3.1-pro-preview">3.1 Pro Preview</option></optgroup>
                        <option value="custom">✏️ 직접 입력...</option>
                    </select>
                    <input type="text" id="ct-model-custom" class="text_pole" placeholder="모델명 직접 입력" style="display:none; margin-top:4px;">
                </div>
            </div>
            <div style="display:flex; gap:8px;">
                <div class="cat-setting-row" style="flex:1;"><label>자동 번역</label><select id="ct-auto-mode" class="text_pole"><option value="none">꺼짐</option><option value="input">입력만</option><option value="output">출력만</option><option value="both">둘 다</option></select></div>
                <div class="cat-setting-row" style="flex:1;"><label>양방향 번역</label><select id="ct-bidirectional" class="text_pole"><option value="off">꺼짐</option><option value="ko-en">한↔영</option><option value="ko-ja">한↔일</option><option value="ko-zh">한↔중</option></select></div>
            </div>
            <div class="cat-setting-row"><label>고속 번역 (모든 모델)</label><select id="ct-non-gemini-fast" class="text_pole"><option value="off">꺼짐 (기존 번역 경로)</option><option value="on">켜짐 (속도 우선·문맥 축약)</option></select></div>
            <div style="font-size:0.8em; opacity:0.72; margin:-2px 0 8px; line-height:1.45;">Gemini·비제미나이 모두 지원합니다. 문맥을 짧게 보내고 재시도를 줄입니다. 사전·사용자 지침과 의미·성별·수치 보존 지침은 유지하지만, 맞춤법과 의미 정확도를 완전히 보장하지는 않습니다. 실제 속도는 모델과 서버에 따라 달라집니다.</div>
            <div style="display:flex; gap:8px;">
                <div class="cat-setting-row" style="flex:1;"><label>입력 내부 번역</label><select id="ct-internal-input" class="text_pole"><option value="off">꺼짐</option><option value="on">켜짐</option></select></div>
                <div class="cat-setting-row" style="flex:1;"><label>AI 전달 언어</label><select id="ct-internal-input-lang" class="text_pole"><option value="English">English</option><option value="Japanese">Japanese</option><option value="Chinese">Chinese</option><option value="German">German</option><option value="Russian">Russian</option><option value="French">French</option></select></div>
            </div>
            <div style="font-size:0.8em; opacity:0.65; margin:-2px 0 8px; line-height:1.45;">💡 켜면 작성한 한국어는 화면에 유지되고, AI에는 선택한 언어로 번역되어 전달됩니다. ✏️는 한국어 원문, 🐟/🍖는 실제 전달문을 수정합니다.</div>
            <div style="display:flex; gap:8px;">
                <div class="cat-setting-row" style="flex:1;"><label>목표 언어 (AI 기본)</label><select id="ct-lang" class="text_pole">${langOptions}</select></div>
                <div class="cat-setting-row" style="flex:1;"><label>대사 병기</label><select id="ct-dialogue-bilingual" class="text_pole"><option value="off">꺼짐</option><option value="ko-en">한영 병기</option><option value="ko-ja">한일 병기</option><option value="ko-zh">한중 병기</option></select></div>
                <div class="cat-setting-row" style="flex:1;"><label>🔍 직역 병기</label><select id="ct-literal-bilingual" class="text_pole"><option value="off">꺼짐</option><option value="on">켜짐 (접이식)</option></select></div>
            </div>
            <div style="display:flex; gap:8px;">
                <div class="cat-setting-row" style="flex:1;"><label>스타일</label><select id="ct-style" class="text_pole">${styleOptions}</select></div>
                <div class="cat-setting-row" style="width:80px;"><label>온도</label><input type="number" id="ct-temperature" class="text_pole" value="${settings.temperature || ''}" min="0" max="1" step="0.1" placeholder="0.0~1.0"></div>
            </div>
            <div style="display:flex; gap:8px;">
                <div class="cat-setting-row" style="flex:1;"><label>토큰</label><input type="number" id="ct-max-tokens" class="text_pole" value="${settings.maxTokens || ''}" min="256" max="20000" step="256" placeholder="권장 8192"></div>
                <div class="cat-setting-row" style="width:100px;"><label>문맥 범위</label><input type="number" id="ct-context-range" class="text_pole" value="${settings.contextRange || ''}" min="0" max="6" step="1" placeholder="최대 6"></div>
            </div>
            <div class="cat-setting-row">
                <label>재번역 강도 <span style="font-size:0.8em; opacity:0.6;">(이전 번역과 얼마나 다르게)</span></label>
                <select id="ct-retranslate-strength" class="text_pole">
                    <option value="soft" ${(settings.retranslateStrength === 'soft') ? 'selected' : ''}>약함 (살짝만 변형, 품질 유지)</option>
                    <option value="normal" ${(settings.retranslateStrength === 'normal' || !settings.retranslateStrength) ? 'selected' : ''}>보통 (다른 표현 시도)</option>
                    <option value="strong" ${(settings.retranslateStrength === 'strong') ? 'selected' : ''}>강함 (완전히 다르게 강제)</option>
                </select>
            </div>
            <div class="cat-setting-row">
                <label>원문 수정 후 동작 <span style="font-size:0.8em; opacity:0.6;">(✏️ 연필로 영어 수정 시)</span></label>
                <select id="ct-after-edit" class="text_pole">
                    <option value="notify" ${(!settings.afterEditMode || settings.afterEditMode === 'notify') ? 'selected' : ''}>알림 + 재번역 버튼 (기본)</option>
                    <option value="auto" ${settings.afterEditMode === 'auto' ? 'selected' : ''}>자동 재번역</option>
                    <option value="keep" ${settings.afterEditMode === 'keep' ? 'selected' : ''}>기존 번역 유지</option>
                </select>
            </div>
            <div class="cat-setting-row">
                <label>📁 채팅 파일 관리 미리보기 <span style="font-size:0.8em; opacity:0.6;">(채팅 기록 팝업에서 🐯 버튼 사용)</span></label>
                <div style="font-size:0.85em; opacity:0.7; padding:5px 0; line-height:1.4;">
                    💡 채팅 기록 팝업 열면 헤더에 <b>[🐯 번역]</b> 버튼, 각 채팅 옆에 <b>🐯</b>(영문)/<b>🐱</b>(한국어) 버튼 자동 표시. 
                    처리 후 <b>🥩</b>/<b>🐟</b>로 변신 → 누르면 되돌리기.
                </div>
            </div>
            <div class="cat-setting-row">
                <label>🧹 미리보기 마크업 정리 <span style="font-size:0.8em; opacity:0.6;">(yaml/태그 자동 숨김, 비용 0)</span></label>
                <select id="ct-preview-cleanup" class="text_pole">
                    <option value="off" ${(!settings.previewCleanup || settings.previewCleanup === 'off') ? 'selected' : ''}>OFF</option>
                    <option value="on" ${settings.previewCleanup === 'on' ? 'selected' : ''}>ON</option>
                </select>
            </div>
            <div class="cat-setting-row" style="display:none"><label>시스템 보호막 (🔒 고정)</label><textarea id="ct-shield" class="text_pole cat-readonly-area" rows="3" readonly>${SYSTEM_SHIELD}</textarea></div>
            <div class="cat-setting-row">
                <label style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:4px;">
                    <span>사용자 추가 지시</span>
                    <span style="display:inline-flex; gap:4px; align-items:center;">
                        <select id="ct-prompt-preset" class="text_pole" style="width:auto; min-width:80px; font-size:0.85em; padding:2px 4px;"><option value="">기본 설정</option></select>
                        <span id="ct-prompt-new" style="cursor:pointer; font-size:1.2em;" title="새 사용자 설정 만들기">➕</span>
                        <span id="ct-prompt-save" style="cursor:pointer; font-size:1.2em;" title="현재 선택된 설정에 통합·서술·대사 지침 + 문체·온도 저장">💾</span>
                        <span id="ct-prompt-delete" style="cursor:pointer; font-size:1.2em;" title="선택한 프롬프트 삭제">🗑️</span>
                        <span id="ct-prompt-link" style="cursor:pointer; font-size:1.2em;" title="현재 캐릭터에 프롬프트 연결">🔗</span>
                    </span>
                </label>
                <label style="font-size:0.82em; opacity:0.78; margin-top:5px;">통합 지시사항</label>
                <textarea id="ct-common-prompt" class="text_pole" rows="3" placeholder="서술과 대사 전체에 적용할 지시사항">${settings.commonPrompt || settings.userPrompt || ''}</textarea>
                <label style="font-size:0.82em; opacity:0.78; margin-top:5px;">서술 지시사항</label>
                <textarea id="ct-narration-prompt" class="text_pole" rows="3" placeholder="서술과 묘사에만 적용할 문체·문장 지시사항">${settings.narrationPrompt || ''}</textarea>
                <label style="font-size:0.82em; opacity:0.78; margin-top:5px;">대사 지시사항</label>
                <textarea id="ct-dialogue-prompt" class="text_pole" rows="3" placeholder="따옴표 안 대사에만 적용할 말투·호칭 지시사항">${settings.dialoguePrompt || ''}</textarea>
            </div>
            <div class="cat-setting-row">
                <label>인풋 번역 프롬프트 (입력창 전용)</label>
                <textarea id="ct-input-user-prompt" class="text_pole" rows="2" placeholder="비워두면 공통 지침과 대사·말투 지침을 사용해요. 캐릭터 프리셋의 영향을 받지 않는 전역 설정입니다.">${settings.inputUserPrompt || ''}</textarea>
            </div>
            <div class="cat-setting-row">
                <label>사전 (원문 = 번역어) 
                    <span id="ct-dict-reset" style="float:right; cursor:pointer; font-size:1.4em; transition:0.2s;" title="사전 지우기 (우편함 비우기)">${dictIcon}</span>
                </label>
                <textarea id="ct-dictionary" class="text_pole" rows="3" placeholder="Ghost=고스트&#10;Soap=소프">${settings.dictionary || ''}</textarea>
            </div>
            <div class="cat-setting-row"><label>아이콘 표시</label><select id="ct-icon-visibility" class="text_pole"><option value="all">전체 보기</option><option value="hide-input">입력창 숨기기</option><option value="hide-message">메시지창 숨기기</option></select></div>
            <div id="ct-cache-stats" class="cat-stats-bar"><span id="ct-cache-icon" style="font-size:1.3em;">🗂️</span> 캐시 히트율: ${statsData.hitRate}% | 절약 토큰: ~${statsData.tokensSaved.toLocaleString()}</div>
            <div style="display:flex; gap:8px; margin-top:4px;">
                <button id="ct-clear-cache" class="menu_button cat-btn-secondary" style="flex:1;">🗑️ 캐시 삭제</button>
                <button id="ct-reset-settings" class="menu_button cat-btn-secondary" style="flex:1;">🔄 설정 초기화</button>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px;">
                <button id="ct-export" class="menu_button cat-btn-secondary" style="flex:1;">📤 내보내기</button><button id="ct-import-btn" class="menu_button cat-btn-secondary" style="flex:1;">📥 가져오기</button>
                <input type="file" id="ct-import-file" accept=".json" style="display:none;">
            </div>
            <button id="ct-clean-chat" class="menu_button cat-btn-secondary" style="width:100%; margin-top:8px;">🧹 현재 채팅 오염 정리 (자동 재번역 안 될 때)</button>
            <button id="cat-save-btn" class="menu_button cat-save-button" style="margin-top:10px; width:100%;">설정 저장 및 적용 <span class="cat-theme-emoji">🐱</span></button>
            <button id="ct-debug-btn" class="menu_button cat-btn-secondary" style="margin-top:6px; width:100%;">🐛 마지막 LLM 응답 보기</button>
        </div>
    </div>`;

    $('#extensions_settings').append(html);

    $('#cat-drawer-header').on('click', (e) => { e.stopPropagation(); $('#cat-drawer-content').slideToggle(200); $('#cat-drawer-toggle').toggleClass('fa-circle-chevron-down fa-circle-chevron-up'); });
    $('#ct-key-toggle').on('click', () => { const i = $('#ct-key'); i.attr('type', i.attr('type') === 'password' ? 'text' : 'password'); });
    
    // 🚨 디버그 팝업
    $('#ct-debug-btn').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showDebugPopup();
    });
    
    // 🚨 자동 저장 디바운스 시스템
    const autoSave = () => {
        if (_suppressAutoSave) return;
        clearTimeout(_autoSaveTimer);
        _autoSaveTimer = setTimeout(() => {
            if (_suppressAutoSave) return;
            saveSettingsFn();
            catNotify(`${getCompletionEmoji()} 설정이 자동 저장되었습니다.`, "autosave");
        }, 500);
    };
    
    // 모든 설정 필드에 자동 저장 연결
    $('#ct-profile, #ct-auto-mode, #ct-non-gemini-fast, #ct-bidirectional, #ct-internal-input, #ct-internal-input-lang, #ct-dialogue-bilingual, #ct-literal-bilingual, #ct-lang, #ct-style, #ct-temperature, #ct-max-tokens, #ct-context-range, #ct-retranslate-strength, #ct-after-edit, #ct-preview-cleanup').on('change', autoSave);
    $('#ct-key, #ct-model-custom, #ct-common-prompt, #ct-narration-prompt, #ct-dialogue-prompt, #ct-input-user-prompt, #ct-dictionary').on('input', autoSave);

    $('#ct-non-gemini-fast').on('change', function () {
        if ($(this).val() !== 'on') return;
        const accepted = confirm(
            '고속 번역은 모든 모델에 적용됩니다. 속도를 위해 문맥을 축약하며, 통신·품질 재시도를 합쳐 API를 최대 2회 호출합니다.\n\n' +
            '사전·사용자 지침과 의미·성별 보존 지침을 유지하고 목표 언어·심각한 누락을 검사합니다. 맞춤법·성별·의역 오류를 완전히 검출하는 기능은 아닙니다.\n\n' +
            '품질보다 속도를 우선하는 설정입니다. 켤까요?'
        );
        if (!accepted) {
            $(this).val('off');
            settings.nonGeminiFastMode = 'off';
            autoSave();
            catNotify('고속 번역을 켜지 않았습니다.', 'info');
            return;
        }
        settings.nonGeminiFastMode = 'on';
        catNotify('⚡ 고속 번역 켜짐 · 모든 모델에 문맥 축약 적용', 'info');
    });
    
    $('#ct-model').val(settings.directModel).on('change', function () {
        const val = $(this).val();
        $('#ct-model-custom').toggle(val === 'custom');
        if (val !== 'custom') {
            // 🚨 bodyObserver 레이스 컨디션 방지: autoSave 전에 즉시 반영
            settings.directModel = val;
            applyTheme(getModelTheme(val), true);
        }
        autoSave();
    });
    $('#ct-model-custom').val(settings.customModelName || '').on('input', function () { settings.customModelName = $(this).val(); applyTheme(getModelTheme($(this).val()), true); });
    // 🚨 직접 연결 토글 버튼
    $('#ct-direct-toggle').on('click', function () {
        const ds = $('#ct-direct-settings');
        const arrow = $('#ct-direct-arrow');
        if (ds.is(':visible')) {
            ds.slideUp(200);
            arrow.text('▶');
        } else {
            ds.slideDown(200);
            arrow.text('▼');
        }
    });
    $('#ct-profile').val(settings.profile).on('change', function () {
        settings.profile = $(this).val();
        const pn = $(this).find('option:selected').text().toLowerCase();
        if (pn.includes('pro') || pn.includes('프로') || pn.includes('tiger') || pn.includes('호랑이')) {
            applyTheme('tiger', true);
        } else if (pn.includes('flash') || pn.includes('플래') || pn.includes('플레') || pn.includes('cat') || pn.includes('고양이')) {
            applyTheme('cat', true);
        } else if (settings.profile === '') {
            applyTheme(getModelTheme(settings.directModel), true);
        } else {
            applyTheme('cat', true);
        }
    });
    $('#ct-style').val(settings.style || 'normal').on('change', function () { if (_suppressAutoSave) return; const preset = STYLE_PRESETS[$(this).val()]; if (preset) $('#ct-temperature').val(preset.temperature); });
    $('#ct-auto-mode').val(settings.autoMode); $('#ct-non-gemini-fast').val(settings.nonGeminiFastMode || 'off'); $('#ct-bidirectional').val(settings.bidirectional || 'off'); $('#ct-internal-input').val(settings.internalInputTranslation || 'off'); $('#ct-internal-input-lang').val(normalizeInternalInputLanguage(settings.internalInputLanguage)); $('#ct-dialogue-bilingual').val(settings.dialogueBilingual || 'off'); $('#ct-literal-bilingual').val(settings.literalBilingual || 'off'); $('#ct-lang').val(settings.targetLang); $('#ct-temperature').val(settings.temperature || 0.3);
    const syncInternalInputLanguageState = () => $('#ct-internal-input-lang').prop('disabled', ($('#ct-internal-input').val() || 'off') !== 'on');
    $('#ct-internal-input').on('change', syncInternalInputLanguageState);
    syncInternalInputLanguageState();
    
    // 대사 병기 변경 시 알림
    $('#ct-dialogue-bilingual').on('change', function() {
        const val = $(this).val();
        const labels = { 'off': '꺼짐', 'ko-en': '한영 병기', 'ko-ja': '한일 병기', 'ko-zh': '한중 병기' };
        if (val !== 'off') { catNotify(`${getThemeEmoji()} 대사 병기: ${labels[val]} 모드 활성화!`, "success"); }
        else { catNotify(`${getThemeEmoji()} 대사 병기 꺼짐`, "success"); }
    });
    
    // 아이콘 표시 초기값 + 토글 로직
    $('#ct-icon-visibility').val(settings.iconVisibility || 'all').on('change', function() {
        const val = $(this).val();
        if (val === 'hide-input') { $('#cat-input-btn, #cat-input-revert, #cat-bulk-btn').hide(); $('.cat-btn-group').removeClass('cat-hidden'); }
        else if (val === 'hide-message') { $('#cat-input-btn, #cat-input-revert, #cat-bulk-btn').show(); $('.cat-btn-group').addClass('cat-hidden'); }
        else { $('#cat-input-btn, #cat-input-revert, #cat-bulk-btn').show(); $('.cat-btn-group').removeClass('cat-hidden'); }
        autoSave();
    });
    // 초기 적용
    const initIconVis = settings.iconVisibility || 'all';
    if (initIconVis === 'hide-input') { setTimeout(() => $('#cat-input-btn, #cat-input-revert, #cat-bulk-btn').hide(), 500); }
    else if (initIconVis === 'hide-message') { setTimeout(() => $('.cat-btn-group').addClass('cat-hidden'), 500); }
    
    $('#ct-dictionary').on('input', function () {
        settings.dictionary = $(this).val();
        $('#ct-dict-reset').text(settings.dictionary.trim() ? '📬' : '📭');
    });
    $('#ct-dict-reset').on('click', async function() {
        $('#ct-dictionary').val(''); settings.dictionary = ''; saveSettingsFn();
        $(this).text('📭');
        await clearAllCache(); updateCacheStats();
        catNotify(`${getThemeEmoji()} 📭 우편함(사전) 비우기 + 캐시 초기화 완료!`, "success");
    });
    
    $('#ct-common-prompt').on('input', function () { settings.commonPrompt = $(this).val(); });
    $('#ct-narration-prompt').on('input', function () { settings.narrationPrompt = $(this).val(); });
    $('#ct-dialogue-prompt').on('input', function () { settings.dialoguePrompt = $(this).val(); });
    $('#ct-input-user-prompt').on('input', function () { settings.inputUserPrompt = $(this).val(); });
    
    // 🚨 번역 프롬프트 프리셋 시스템
    const _rebuildPresetDropdown = () => {
        const select = $('#ct-prompt-preset');
        const currentVal = select.val();
        select.find('option:not(:first)').remove();
        Object.keys(settings.promptPresets || {}).forEach(name => {
            select.append(`<option value="${name}">${name}</option>`);
        });
        if (currentVal && settings.promptPresets?.[currentVal]) select.val(currentVal);
    };
    _rebuildPresetDropdown();

    const _renderPromptFields = () => {
        $('#ct-common-prompt').val(settings.commonPrompt || '');
        $('#ct-narration-prompt').val(settings.narrationPrompt || '');
        $('#ct-dialogue-prompt').val(settings.dialoguePrompt || '');
        $('#ct-style').val(settings.style || 'normal');
        $('#ct-temperature').val(settings.temperature ?? 0.3);
    };

    const _activateDefaultPromptSettings = () => {
        _suppressAutoSave = true;
        clearTimeout(_autoSaveTimer);
        const restored = restoreDefaultPromptSettingsFn?.() || {};
        Object.assign(settings, restored);
        _renderPromptFields();
        $('#ct-prompt-preset').val('');
        _suppressAutoSave = false;
        saveSettingsFn();
        catNotify(`${getThemeEmoji()} 기본 설정으로 전환!`, "success");
    };
    
    // 프롬프트 선택 시 로드
    $('#ct-prompt-preset').on('change', function() {
        const name = $(this).val();
        if (!name) {
            _activateDefaultPromptSettings();
            return;
        }
        const preset = settings.promptPresets?.[name];
        if (preset) {
            _suppressAutoSave = true;  // 🚨 로드 중 autoSave/스타일핸들러 차단
            clearTimeout(_autoSaveTimer);
            // 구버전 단일 prompt는 전체 번역용이었으므로 공통 지침으로 이전한다.
            settings.commonPrompt = preset.commonPrompt ?? preset.prompt ?? '';
            settings.narrationPrompt = preset.narrationPrompt ?? '';
            settings.dialoguePrompt = preset.dialoguePrompt ?? '';
            settings.temperature = preset.temperature ?? 0.3;
            settings.style = preset.style || 'normal';
            _renderPromptFields();
            _suppressAutoSave = false;
            saveSettingsFn();
            catNotify(`${getThemeEmoji()} 프롬프트 "${name}" 로드!`, "success");
        }
    });
    
    const _readPromptSettings = () => ({
        commonPrompt: ($('#ct-common-prompt').val() || '').trim(),
        narrationPrompt: ($('#ct-narration-prompt').val() || '').trim(),
        dialoguePrompt: ($('#ct-dialogue-prompt').val() || '').trim(),
        temperature: parseFloat($('#ct-temperature').val()) || 0.3,
        style: $('#ct-style').val() || 'normal'
    });

    // 새 사용자 설정 만들기 — 세 지침이 모두 비어 있어도 생성할 수 있다.
    $('#ct-prompt-new').on('click', function() {
        const name = prompt('새 설정 이름을 입력하세요:', '');
        if (!name || !name.trim()) return;
        if (!settings.promptPresets) settings.promptPresets = {};
        settings.promptPresets[name.trim()] = _readPromptSettings();
        _rebuildPresetDropdown();
        $('#ct-prompt-preset').val(name.trim());
        saveSettingsFn();
        catNotify(`${getThemeEmoji()} 사용자 설정 "${name.trim()}" 생성 완료!`, "success");
    });

    // 현재 선택 슬롯에 저장. 기본 설정은 빈 지침도 정상값으로 저장한다.
    $('#ct-prompt-save').on('click', function() {
        const name = $('#ct-prompt-preset').val();
        const values = _readPromptSettings();
        Object.assign(settings, values);
        if (!name) {
            const charName = (SillyTavern?.getContext?.()?.name2) || stContext.name2 || '';
            if (charName && settings.charPresetMap?.[charName]) delete settings.charPresetMap[charName];
            saveSettingsFn(true);
            catNotify(`${getThemeEmoji()} 기본 설정 저장 완료!`, "success");
            return;
        }
        if (!settings.promptPresets) settings.promptPresets = {};
        settings.promptPresets[name] = values;
        saveSettingsFn();
        catNotify(`${getThemeEmoji()} 사용자 설정 "${name}" 저장 완료!`, "success");
    });
    
    // 프롬프트 삭제
    $('#ct-prompt-delete').on('click', function() {
        const name = $('#ct-prompt-preset').val();
        if (!name) { catNotify(`⚠️ 삭제할 프롬프트를 선택하세요.`, "warning"); return; }
        if (!confirm(`"${name}" 프롬프트를 삭제하시겠습니까?`)) return;
        delete settings.promptPresets?.[name];
        // 연결된 캐릭터 매핑도 정리
        if (settings.charPresetMap) {
            Object.keys(settings.charPresetMap).forEach(char => {
                if (settings.charPresetMap[char] === name) delete settings.charPresetMap[char];
            });
        }
        _rebuildPresetDropdown();
        _activateDefaultPromptSettings();
        catNotify(`${getThemeEmoji()} 프롬프트 "${name}" 삭제 완료!`, "success");
    });
    
    // 현재 캐릭터에 프롬프트 연결
    $('#ct-prompt-link').on('click', function() {
        const name = $('#ct-prompt-preset').val();
        // 🚨 클릭 시점의 최신 캐릭터 이름 사용
        const charName = (SillyTavern?.getContext?.()?.name2) || stContext.name2 || '';
        if (!charName || charName === 'SillyTavern System') {
            catNotify(`⚠️ 캐릭터 채팅을 먼저 열어주세요!`, "warning"); return;
        }
        if (!settings.charPresetMap) settings.charPresetMap = {};
        if (!name) {
            // 연결 해제
            delete settings.charPresetMap[charName];
            saveSettingsFn();
            catNotify(`${getThemeEmoji()} ${charName} 프롬프트 연결 해제!`, "success");
        } else {
            settings.charPresetMap[charName] = name;
            saveSettingsFn();
            catNotify(`${getThemeEmoji()} ${charName} → "${name}" 연결 완료!`, "success");
        }
    });
    
    $('#ct-context-range').on('change', function () { let val = parseInt($(this).val()) || 0; val = Math.min(6, Math.max(0, val)); $(this).val(val); });
    $('#cat-save-btn').on('click', () => { saveSettingsFn(true); catNotify(`${getThemeEmoji()} 저장 완료! 기본 설정이 확정되었습니다.`, "success"); });
    $('#ct-clear-cache').on('click', async () => { await clearAllCache(); updateCacheStats(); catNotify(`${getThemeEmoji()} 캐시 전체 삭제 완료! 📂`, "success"); });
    
    // 🚨 오염 채팅 정리: 자동 재번역이 안 되는 경우 사용
    $('#ct-clean-chat').on('click', () => {
        const ctx = SillyTavern?.getContext?.();
        if (!ctx?.chat) { catNotify(`${getThemeEmoji()} 채팅을 찾을 수 없어요`, "warning"); return; }
        if (!confirm('현재 채팅의 모든 메시지에서 swipe 번역 캐시 + 동기화 정보 + 편집 상태를 정리합니다.\n\n표시되는 번역(display_text)은 유지되지만, 다른 스와이프의 저장된 번역들은 삭제됩니다.\n\n계속하시겠어요?')) return;
        
        let cleaned = 0;
        let damaged = []; // 영어 원본이 손실된 메시지 ID
        
        ctx.chat.forEach((msg, i) => {
            if (!msg?.extra) return;
            let touched = false;
            
            // 1. swipe_translations 정리
            if (msg.extra.swipe_translations) { delete msg.extra.swipe_translations; touched = true; }
            if (msg.extra.cat_swipe_id !== undefined) { delete msg.extra.cat_swipe_id; touched = true; }
            
            // 2. 한국어 오염 검사
            const mesIsKorean = msg.extra.original_mes && /[가-힣]/.test(msg.mes) && msg.mes.length > 10;
            const origIsKorean = msg.extra.original_mes && /[가-힣]/.test(msg.extra.original_mes) && msg.extra.original_mes.length > 10;
            
            if (origIsKorean) {
                // 🚨 영어 원본 자체가 손실됨 - 복구 불가
                damaged.push(i);
            } else if (mesIsKorean && msg.extra.original_mes) {
                // msg.mes만 오염 → original_mes에서 복원 가능
                msg.mes = msg.extra.original_mes;
                touched = true;
            }
            
            // 3. DOM 측 정리
            const $mes = $(`.mes[mesid="${i}"]`);
            if ($mes.length > 0) {
                $mes.removeData('cat-edit-active')
                    .removeData('cat-edit-display')
                    .removeData('cat-edit-original')
                    .removeData('cat-edit-type')
                    .removeData('cat-captured-text')
                    .removeData('cat-last-textarea')
                    .removeData('cat-direct-bound');
                $mes.find('.cat-glow-anim').removeClass('cat-glow-anim');
            }
            
            if (touched) cleaned++;
        });
        
        // 4. 글로벌 캡처 Map 초기화
        if (window._catCapturedText) window._catCapturedText.clear();
        
        try { ctx.saveChat(); } catch (e) {}
        
        let msg = `${getThemeEmoji()} ${cleaned}개 메시지 정리 완료!`;
        if (damaged.length > 0) {
            msg += `\n\n⚠️ 영어 원본 손상 (#${damaged.join(', #')}): 이 메시지들은 자동 재번역 불가. ST의 🔄 재생성 또는 메시지 삭제 필요.`;
        }
        catNotify(msg, damaged.length > 0 ? "warning" : "success");
        
        setTimeout(() => {
            if (confirm('정리 완료! 그래도 자동 재번역이 안 되면 페이지 새로고침을 권장해요. 지금 새로고침할까요?')) {
                location.reload();
            }
        }, 1500);
    });
    
    $('#ct-reset-settings').on('click', () => {
        if (!confirm('모든 설정을 초기값으로 되돌리시겠습니까?')) return;
        $('#ct-profile').val(''); $('#ct-key').val('');
        $('#ct-model').val('gemini-2.5-flash'); $('#ct-model-custom').val('').hide();
        $('#ct-auto-mode').val('none'); $('#ct-non-gemini-fast').val('off'); $('#ct-bidirectional').val('off'); $('#ct-internal-input').val('off'); $('#ct-internal-input-lang').val('English').prop('disabled', true); $('#ct-dialogue-bilingual').val('off'); $('#ct-literal-bilingual').val('off'); $('#ct-icon-visibility').val('all'); $('#ct-lang').val('Korean'); $('#ct-style').val('normal'); $('#ct-retranslate-strength').val('normal'); $('#ct-after-edit').val('notify'); $('#ct-preview-cleanup').val('off');
        $('#ct-temperature').val(0.3); $('#ct-max-tokens').val(8192); $('#ct-context-range').val(1);
        $('#ct-common-prompt').val(''); $('#ct-narration-prompt').val(''); $('#ct-dialogue-prompt').val(''); $('#ct-dictionary').val(''); $('#ct-dict-reset').text('📭');
        settings.commonPrompt = ''; settings.narrationPrompt = ''; settings.dialoguePrompt = ''; settings.userPrompt = '';
        settings.promptPresets = {}; settings.charPresetMap = {}; $('#ct-prompt-preset').val('').find('option:not(:first)').remove();
        $('#ct-direct-settings').hide(); $('#ct-direct-arrow').text('▶');
        $('#cat-input-btn, #cat-input-revert, #cat-bulk-btn').show(); $('.cat-btn-group').removeClass('cat-hidden');
        saveSettingsFn(true); catNotify(`${getThemeEmoji()} 설정이 초기화되었습니다!`, "success");
    });
    $('#ct-export').on('click', () => { saveSettingsFn(); exportSettings(settings); catNotify(`${getThemeEmoji()} 설정 내보내기 완료!`, "success"); });
    $('#ct-import-btn').on('click', () => $('#ct-import-file').click());
    $('#ct-import-file').on('change', async function () { const file = this.files[0]; if (!file) return; try { const imported = await importSettings(file); Object.assign(settings, imported); saveSettingsFn(true); catNotify(`${getThemeEmoji()} 설정 가져오기 완료! 새로고침하면 적용됩니다.`, "success"); } catch (e) { catNotify(`${getThemeEmoji()} 오류: ${e.message}`, "error"); } this.value = ''; });
    
    const initialProfileName = ($('#ct-profile option:selected').text() || '').toLowerCase();
    const initialModel = (settings.directModel || '').toLowerCase();
    const allNames = initialProfileName + ' ' + initialModel;
    if (allNames.includes('pro') || allNames.includes('프로') || allNames.includes('호랑이') || allNames.includes('tiger')) {
        applyTheme('tiger');
    } else {
        applyTheme('cat');
    }
    return true;
}

export function collectSettings() {
    const modelVal = $('#ct-model').val();
    
    // 🚨 textarea가 DOM에 없거나 비어있고, _settingsRef에 값이 있으면 보존
    // (설정 패널 닫힌 상태에서 saveSettings 호출되는 경우 데이터 손실 방지)
    const dictTextarea = $('#ct-dictionary');
    const commonPromptTextarea = $('#ct-common-prompt');
    const narrationPromptTextarea = $('#ct-narration-prompt');
    const dialoguePromptTextarea = $('#ct-dialogue-prompt');
    const dictValue = dictTextarea.length > 0 ? (dictTextarea.val() || '') : (_settingsRef?.dictionary || '');
    const commonPromptValue = commonPromptTextarea.length > 0 ? (commonPromptTextarea.val() || '') : (_settingsRef?.commonPrompt || _settingsRef?.userPrompt || '');
    const narrationPromptValue = narrationPromptTextarea.length > 0 ? (narrationPromptTextarea.val() || '') : (_settingsRef?.narrationPrompt || '');
    const dialoguePromptValue = dialoguePromptTextarea.length > 0 ? (dialoguePromptTextarea.val() || '') : (_settingsRef?.dialoguePrompt || '');
    
    // textarea가 DOM에 있는데 비어있고 _settingsRef에 값이 있으면 → 일시적 미초기화 가능성
    const safeDictValue = (dictTextarea.length > 0 && !dictValue && _settingsRef?.dictionary) 
        ? _settingsRef.dictionary 
        : dictValue;
    const safeCommonPromptValue = (commonPromptTextarea.length > 0 && !commonPromptValue && _settingsRef?.commonPrompt)
        ? _settingsRef.commonPrompt
        : commonPromptValue;
    const safeNarrationPromptValue = (narrationPromptTextarea.length > 0 && !narrationPromptValue && _settingsRef?.narrationPrompt)
        ? _settingsRef.narrationPrompt
        : narrationPromptValue;
    const safeDialoguePromptValue = (dialoguePromptTextarea.length > 0 && !dialoguePromptValue && _settingsRef?.dialoguePrompt)
        ? _settingsRef.dialoguePrompt
        : dialoguePromptValue;
    // 🚨 v1.1.4-beta.3: 인풋 전용 프롬프트도 동일한 손실 방지 패턴 적용
    const inputPromptTextarea = $('#ct-input-user-prompt');
    const inputPromptValue = inputPromptTextarea.length > 0 ? (inputPromptTextarea.val() || '') : (_settingsRef?.inputUserPrompt || '');
    const safeInputPromptValue = (inputPromptTextarea.length > 0 && !inputPromptValue && _settingsRef?.inputUserPrompt)
        ? _settingsRef.inputUserPrompt
        : inputPromptValue;
    
    return {
        profile: $('#ct-profile').val() ?? _settingsRef?.profile ?? '', customKey: $('#ct-key').val() ?? _settingsRef?.customKey ?? '',
        vertexKey: _settingsRef?.vertexKey || '', vertexProject: _settingsRef?.vertexProject || '',
        vertexRegion: _settingsRef?.vertexRegion || 'global',
        directModel: modelVal === 'custom' ? ($('#ct-model-custom').val() || _settingsRef?.directModel || 'gemini-2.5-flash') : (modelVal || _settingsRef?.directModel || 'gemini-2.5-flash'),
        customModelName: $('#ct-model-custom').val() || _settingsRef?.customModelName || '', autoMode: $('#ct-auto-mode').val() || _settingsRef?.autoMode || 'none',
        nonGeminiFastMode: $('#ct-non-gemini-fast').val() || _settingsRef?.nonGeminiFastMode || 'off',
        internalInputTranslation: $('#ct-internal-input').val() || _settingsRef?.internalInputTranslation || 'off',
        internalInputLanguage: normalizeInternalInputLanguage($('#ct-internal-input-lang').val() || _settingsRef?.internalInputLanguage),
        bidirectional: $('#ct-bidirectional').val() || _settingsRef?.bidirectional || 'off', dialogueBilingual: $('#ct-dialogue-bilingual').val() || _settingsRef?.dialogueBilingual || 'off', literalBilingual: $('#ct-literal-bilingual').val() || _settingsRef?.literalBilingual || 'off', iconVisibility: $('#ct-icon-visibility').val() || _settingsRef?.iconVisibility || 'all',
        targetLang: $('#ct-lang').val() || _settingsRef?.targetLang || 'Korean', style: $('#ct-style').val() || _settingsRef?.style || 'normal',
        temperature: parseFloat($('#ct-temperature').val()) || _settingsRef?.temperature || 0.3, maxTokens: parseInt($('#ct-max-tokens').val()) || _settingsRef?.maxTokens || 8192,
        contextRange: normalizeContextRange($('#ct-context-range').val(), normalizeContextRange(_settingsRef?.contextRange)),
        commonPrompt: safeCommonPromptValue, narrationPrompt: safeNarrationPromptValue, dialoguePrompt: safeDialoguePromptValue, userPrompt: '', inputUserPrompt: safeInputPromptValue, dictionary: safeDictValue,
        retranslateStrength: $('#ct-retranslate-strength').val() || _settingsRef?.retranslateStrength || 'normal',
        afterEditMode: $('#ct-after-edit').val() || _settingsRef?.afterEditMode || 'notify',
        previewTranslate: _settingsRef?.previewTranslate || 'off',
        previewCleanup: $('#ct-preview-cleanup').val() || _settingsRef?.previewCleanup || 'off',
        promptPresets: _settingsRef?.promptPresets || {}, charPresetMap: _settingsRef?.charPresetMap || {}
    };
}
export function updateCacheStats() {
    const s = getStats();
    const icon = s.hits > 0 ? '🗂️' : '📂';
    $('#ct-cache-icon').text(icon);
    $('#ct-cache-stats').html(`<span id="ct-cache-icon" style="font-size:1.3em;">${icon}</span> 캐시 히트율: ${s.hitRate}% | 절약 토큰: ~${s.tokensSaved.toLocaleString()}`);
}
let _lastAppliedTheme = null;
export function applyTheme(theme, notify = false) {
    document.body.setAttribute('data-cat-theme', theme); const emoji = theme === 'tiger' ? '🐯' : '🐱'; const editEmoji = theme === 'tiger' ? '🍖' : '🐟';
    $('.cat-theme-emoji').text(emoji); $('.cat-mes-trans-btn .cat-emoji-icon').text(emoji); $('#cat-input-btn .cat-emoji-icon').text(emoji);
    $('.cat-mes-edit-btn .cat-emoji-icon').text(editEmoji);
    if (notify) {
        if (theme === 'tiger') catNotify('🐯 어흥! 호랑이 모드 활성화!', 'success'); else catNotify('🐱 야옹~ 고양이 모드 활성화!', 'success');
    }
    _lastAppliedTheme = theme;
}

function restoreInternalInputSource(sendArea, sourceText) {
    if (!sendArea) return;
    const draft = String(sendArea.value || '').trim();
    if (!draft) {
        setTextareaValue(sendArea, sourceText);
    } else if (draft !== sourceText) {
        setTextareaValue(sendArea, `${sourceText}\n\n${sendArea.value}`);
    }
}

function setupInternalInputSendInterceptor(settings, stContext) {
    if (window.__catInternalInputInterceptorInstalled) return;
    window.__catInternalInputInterceptorInstalled = true;

    const interceptSend = async event => {
        if (_internalInputSendBypass || (settings.internalInputTranslation || 'off') !== 'on') return;
        if (shouldKeepInternalInputEnter(event, true)) {
            // 기본 동작(IME 확정·textarea 줄바꿈)은 살리고 ST 전송 리스너만 차단한다.
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }
        const isSendClick = event.type === 'click' && event.target?.closest?.('#send_but');
        if (!isSendClick) return;

        const sendArea = document.getElementById('send_textarea');
        const sourceText = String(sendArea?.value || '').trim();
        if (!sendArea || !sourceText || sourceText.startsWith('/')) return;

        const targetLang = normalizeInternalInputLanguage(settings.internalInputLanguage);
        const direction = resolveInputTranslationDirection(sourceText, {
            ...settings,
            targetLang,
            bidirectional: 'off',
            dialogueBilingual: 'off'
        });
        if (!direction.shouldTranslate) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (_internalInputSendBusy) {
            catNotify(`${getThemeEmoji()} 내부 번역이 끝날 때까지 잠깐만요.`, 'info');
            return;
        }

        _internalInputSendBusy = true;
        const requestChatRef = SillyTavern?.getContext?.()?.chat || stContext.chat;
        const transIcon = $('#cat-input-btn .cat-emoji-icon');
        transIcon.addClass('cat-glow-anim');
        pushInputHistory(sourceText);
        catNotify(`${getThemeEmoji()} ${targetLang} 내부 번역 중...`, 'success');

        try {
            if (document.activeElement === sendArea) {
                sendArea.blur();
                await new Promise(resolve => setTimeout(resolve, 20));
            }

            const liveContext = SillyTavern?.getContext?.() || stContext;
            const contextMsgs = gatherInternalInputContextMessages(liveContext.chat.length, liveContext);
            const inputSettings = {
                ...settings,
                dialogueBilingual: 'off',
                literalBilingual: 'off',
                targetLang,
                commonPrompt: '',
                narrationPrompt: '',
                dialoguePrompt: resolveInputUserPrompt(settings),
                userPrompt: ''
            };
            const result = await fetchTranslation(sourceText, inputSettings, liveContext, {
                forceLang: targetLang,
                contextMessages: contextMsgs,
                silent: true,
                internalInputFast: true
            });

            const latestContext = SillyTavern?.getContext?.() || stContext;
            if (latestContext.chat !== requestChatRef) {
                restoreInternalInputSource(sendArea, sourceText);
                catNotify(`${getThemeEmoji()} 채팅이 바뀌어서 이전 번역을 보내지 않았어요.`, 'warning');
                return;
            }
            if (!result?.text?.trim() || result.text.trim() === sourceText) {
                const debug = getLastDebugLog();
                const failureDetail = debug?.error || debug?.quality?.issues?.join('; ') || '입력창에 원문 복구됨';
                restoreInternalInputSource(sendArea, sourceText);
                const shortFailure = String(failureDetail).replace(/\s+/g, ' ').slice(0, 90);
                catNotify(`${getThemeEmoji()} 내부 번역 실패: ${shortFailure}`, 'warning');
                return;
            }

            const translatedText = result.text.trim();
            const sourceNewlines = (sourceText.match(/\n/g) || []).length;
            const translatedNewlines = (translatedText.match(/\n/g) || []).length;
            const hijacked = translatedText.length > Math.max(300, sourceText.length * 4) ||
                (translatedText.length > sourceText.length * 2.5 && translatedNewlines > sourceNewlines + 3);
            if (hijacked) {
                console.warn(`[CAT] 🛡️ 내부 입력 하이재킹 차단: ${sourceText.length}자 → ${translatedText.length}자`);
                restoreInternalInputSource(sendArea, sourceText);
                catNotify(`${getThemeEmoji()} 번역 모델이 RP를 이어 쓴 것 같아서 전송을 막았어요.`, 'warning');
                return;
            }
            const currentDraft = String(sendArea.value || '');
            const nextDraft = currentDraft.trim() === sourceText ? '' : currentDraft;
            window.__catPendingInternalInput = {
                version: 1,
                sourceText,
                translatedText,
                targetLang,
                chatRef: requestChatRef,
                createdAt: Date.now(),
                nextDraft
            };
            const pendingCreatedAt = window.__catPendingInternalInput.createdAt;
            setTextareaValue(sendArea, translatedText);

            const sendButton = document.getElementById('send_but');
            if (!sendButton) {
                window.__catPendingInternalInput = null;
                setTextareaValue(sendArea, nextDraft || sourceText);
                catNotify(`${getThemeEmoji()} 전송 버튼을 찾지 못해서 전송을 중단했어요.`, 'warning');
                return;
            }

            _internalInputSendBypass = true;
            sendButton.click();
            queueMicrotask(() => { _internalInputSendBypass = false; });
            // ST가 전송문을 채팅 배열에 붙이기 전에 입력창을 0ms로 되돌리면,
            // API는 영문을 받았는데 사용자 메시지만 사라지는 레이스가 발생한다.
            // 실제 USER_MESSAGE_RENDERED/GENERATION_STARTED 연결 뒤에 draft를 복구한다.
            [50, 250, 1000, 3000, 8000].forEach(delay => setTimeout(() => {
                window.__catReconcilePendingInternalInput?.();
            }, delay));
            catNotify(`${getCompletionEmoji()} ${targetLang}로 내부 전달했어요. 화면에는 한국어를 유지합니다.`, 'success');

            setTimeout(() => {
                const pending = window.__catPendingInternalInput;
                if (!pending || pending.createdAt !== pendingCreatedAt) return;
                window.__catPendingInternalInput = null;
                const current = String(sendArea.value || '').trim();
                if (shouldRestoreInternalInputDraft(current, translatedText)) setTextareaValue(sendArea, nextDraft || sourceText);
                catNotify(`${getThemeEmoji()} 내부 번역 메시지 연결을 확인하지 못했어요. 입력창에 원문을 복구했습니다.`, 'warning');
                console.warn('[CAT] ⚠️ 내부 번역 전송 메시지 연결 실패 → 입력창 원문 복구');
            }, 60000);
        } catch (error) {
            console.warn('[CAT] 내부 입력 번역 실패:', error);
            restoreInternalInputSource(sendArea, sourceText);
            catNotify(`${getThemeEmoji()} 내부 번역 오류로 전송을 중단했어요.`, 'warning');
        } finally {
            _internalInputSendBusy = false;
            transIcon.removeClass('cat-glow-anim');
        }
    };

    document.addEventListener('click', interceptSend, true);
    document.addEventListener('keydown', interceptSend, true);
}

export function injectInputButtons(settings, stContext, processMessageFn) {
    setupInternalInputSendInterceptor(settings, stContext);
    if ($('#cat-input-btn').length > 0) {
        const icon = $('#cat-input-btn .cat-emoji-icon'); if (isTranslatingInput) icon.addClass('cat-glow-anim'); else icon.removeClass('cat-glow-anim');
        // 🚨 아이콘 숨김 설정 지속 적용
        const vis = settings.iconVisibility || 'all';
        if (vis === 'hide-input') { $('#cat-input-btn, #cat-input-revert, #cat-bulk-btn').hide(); }
        return;
    }
    const target = $('#send_but'); if (target.length === 0) return;
    const emoji = getThemeEmoji();
    const transBtn = $(`<div id="cat-input-btn" title="번역" class="cat-input-icon interactable"><span class="cat-emoji-icon">${emoji}</span></div>`);
    const revertBtn = $(`<div id="cat-input-revert" title="되돌리기" class="cat-input-icon interactable"><i class="fa-solid fa-rotate-left"></i></div>`);
    const bulkBtn = $(`<div id="cat-bulk-btn" title="전체 번역" class="cat-input-icon interactable"><span class="cat-emoji-icon">⚡</span></div>`);
    target.before(transBtn).before(revertBtn).before(bulkBtn);
    
    // 🚨 생성 직후 아이콘 숨김 설정 적용
    if ((settings.iconVisibility || 'all') === 'hide-input') {
        transBtn.hide(); revertBtn.hide(); bulkBtn.hide();
    }

    transBtn.on('click', async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        const sendArea = $('#send_textarea');
        
        // 🚨 모바일 IME 조합 커밋: 입력 중이면 blur로 조합 확정 후 읽기
        // (삼성 한글 IME 조합 중 val()이 이전 값을 반환 → 새 인풋 유실 방지)
        if (document.activeElement === sendArea[0]) {
            sendArea[0].blur();
            await new Promise(r => setTimeout(r, 80));
        }
        
        const currentText = sendArea.val().trim();
        if (isTranslatingInput || !currentText) return;
        const requestId = ++inputTranslationRequestId;
        isTranslatingInput = true; transBtn.find('.cat-emoji-icon').addClass('cat-glow-anim');
        try {
            const lastTranslated = sendArea.data('cat-last-translated'); const originalText = sendArea.data('cat-original-text'); const lastTargetLang = sendArea.data('cat-last-target-lang');
            const isRetry = (lastTranslated && currentText === lastTranslated);
            
            // 🚨 새 입력 세션 감지 → 이전 세션 stale 데이터 즉시 정리
            // (전송 후에도 jQuery data가 남아서 되돌리기가 옛날 인풋을 복원하는 문제 방지)
            if (!isRetry && lastTranslated) {
                sendArea.removeData('cat-original-text').removeData('cat-last-translated').removeData('cat-last-target-lang');
            }
            
            const textToTranslate = isRetry ? originalText : currentText;
            const prevTrans = isRetry ? currentText : null;
            
            // 🚨 덮어쓰기 전 무조건 히스토리 백업 (어떤 경우에도 인풋 복구 가능)
            pushInputHistory(currentText);
            
            catNotify(isRetry ? `${getThemeEmoji()} 입력창 재번역 중...` : `${getThemeEmoji()} 번역 진행 중...`, "success");
            
            const contextRange = normalizeContextRange(settings.contextRange); const lastMsgId = stContext.chat.length - 1;
            const contextMsgs = gatherContextMessages(lastMsgId + 1, stContext, contextRange);
            const inputDirection = resolveInputTranslationDirection(textToTranslate, settings);
            if (!inputDirection.shouldTranslate) {
                const language = inputDirection.sourceLanguage || inputDirection.targetLang;
                catNotify(`${getThemeEmoji()} 입력문이 이미 ${language}입니다. 그대로 전송하면 돼요.`, "info");
                return;
            }
            console.log(
                `[CAT] 🧭 입력 번역 방향: ${inputDirection.sourceLanguage || 'unknown'} → ${inputDirection.targetLang}` +
                ` (신뢰도 ${Math.round(inputDirection.analysis.confidence * 100)}%)`
            );
            
            // 🚨 v1.1.4-beta.3: 입력창 번역은 전용 프롬프트 사용 (비어있으면 공용 폴백)
            const inputSettings = { ...settings, dialogueBilingual: 'off', literalBilingual: 'off', targetLang: inputDirection.targetLang, commonPrompt: '', narrationPrompt: '', dialoguePrompt: resolveInputUserPrompt(settings), userPrompt: '' };
            const requestChatRef = SillyTavern?.getContext?.()?.chat || stContext.chat;
            const result = await fetchTranslation(textToTranslate, inputSettings, stContext, {
                forceLang: inputDirection.targetLang,
                prevTranslation: prevTrans,
                contextMessages: contextMsgs
            });
            if (result && result.text && result.text !== currentText) {
                const liveChat = SillyTavern?.getContext?.()?.chat || stContext.chat;
                const latestInput = sendArea.val().trim();
                if (requestId !== inputTranslationRequestId || liveChat !== requestChatRef || latestInput !== currentText) {
                    console.warn('[CAT] ⏭️ 입력 번역 중 채팅/입력 변경 → 낡은 결과 폐기');
                    catNotify(`${getThemeEmoji()} 입력 내용이 바뀌어서 이전 번역 결과를 적용하지 않았어요.`, "warning");
                    return;
                }
                // 🚨 하이재킹 감지: AI가 번역 대신 RP 이어쓰기를 준 경우 입력창 보호
                // (3.5 Flash가 컨텍스트에 홀려서 캐릭터 다이얼로그를 생성하는 문제)
                const inLen = textToTranslate.length; const outLen = result.text.length;
                const inNewlines = (textToTranslate.match(/\n/g) || []).length;
                const outNewlines = (result.text.match(/\n/g) || []).length;
                const hijacked = outLen > Math.max(300, inLen * 4) ||
                    (outLen > inLen * 2.5 && outNewlines > inNewlines + 3);
                if (hijacked) {
                    console.warn(`[CAT] 🛡️ 하이재킹 감지: 입력 ${inLen}자 → 출력 ${outLen}자 (줄바꿈 ${inNewlines}→${outNewlines})`);
                    catNotify(`🛡️ AI가 번역 대신 롤플 응답을 준 것 같아서 입력창을 보호했어요. 반복되면 번역 지침과 디버그 로그의 실제 응답을 확인해주세요.`, "warning");
                    return;
                }
                
                sendArea.data('cat-original-text', textToTranslate); sendArea.data('cat-last-translated', result.text); sendArea.data('cat-last-target-lang', result.lang);
                setTextareaValue(sendArea[0], result.text);
                catNotify(`${getCompletionEmoji()} 입력창 번역 완료!`, "success");
            }
        } finally {
            if (requestId === inputTranslationRequestId) {
                isTranslatingInput = false;
                transBtn.find('.cat-emoji-icon').removeClass('cat-glow-anim');
            }
        }
    });
    revertBtn.on('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        inputTranslationRequestId++;
        isTranslatingInput = false;
        transBtn.find('.cat-emoji-icon').removeClass('cat-glow-anim');
        const sendArea = $('#send_textarea'); const originalText = sendArea.data('cat-original-text');
        if (originalText) {
            setTextareaValue(sendArea[0], originalText);
            sendArea.removeData('cat-original-text').removeData('cat-last-translated');
            catNotify(`${getThemeEmoji()} 원문 복구 완료!`, "success");
        } else if (_catInputHistory.length > 0) {
            // 🚨 원본 데이터 없으면 히스토리에서 복구 (인풋 유실 최후 방어선)
            const last = _catInputHistory[_catInputHistory.length - 1];
            setTextareaValue(sendArea[0], last);
            catNotify(`🕘 백업 히스토리에서 복구했어요! (덮어쓰기 직전 입력)`, "success");
        } else {
            catNotify("⚠️ 복구할 원본이 없습니다.", "warning");
        }
    });
    bulkBtn.on('click', (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); showBulkPopup(e, settings, stContext, processMessageFn); });
}

export function injectMessageButtons(processMessageFn, revertMessageFn, roots = null) {
    const messageBlocks = roots ? $(roots).filter('.mes').add($(roots).find('.mes')) : $('.mes');
    const ctx = SillyTavern?.getContext?.();
    messageBlocks.filter(':not(:has(.cat-btn-group))').each(function () {
        const msgId = $(this).attr('mesid'); if (!msgId) return;
        const emoji = getThemeEmoji();
        const editEmoji = getCompletionEmoji();
        // 🚨 번역 데이터 유무에 따라 편집 버튼 표시 결정
        const msg = ctx?.chat?.[parseInt(msgId)];
        const hasTransData = msg?.extra?.original_mes || msg?.extra?.display_text;
        const editStyle = hasTransData ? 'opacity:0.8;' : 'opacity:0;pointer-events:none;';
        const group = $(`<div class="cat-btn-group"><span class="cat-mes-trans-btn interactable" title="번역" data-mesid="${msgId}"><span class="cat-emoji-icon">${emoji}</span></span><span class="cat-mes-revert-btn interactable" title="복구" data-mesid="${msgId}"><i class="fa-solid fa-rotate-left"></i></span><span class="cat-mes-edit-btn interactable" title="편집" data-mesid="${msgId}" style="${editStyle}"><span class="cat-emoji-icon">${editEmoji}</span></span></div>`);
        let target = $(this).find('.name_text'); if (target.length > 0) { target.append(group); } else { let sysWrap = $('<div style="text-align:right; margin-bottom:4px;"></div>'); sysWrap.append(group); $(this).find('.mes_text').first().prepend(sysWrap); }
    });
    // 🚨 이미 번역된 메시지의 편집 버튼 표시 복원 (인라인 스타일)
    if (ctx?.chat) {
        let restoredCount = 0;
        messageBlocks.each(function () {
            const msgId = parseInt($(this).attr('mesid'));
            const msg = ctx.chat[msgId];
            if (msg?.extra?.original_mes || msg?.extra?.display_text) {
                $(this).find('.cat-mes-edit-btn').css({ opacity: 0.8, 'pointer-events': 'auto' });
                restoredCount++;
            }
        });

    }
    // 🚨 메시지 아이콘 숨김 설정 적용
    const vis = $('#ct-icon-visibility').val() || 'all';
    if (vis === 'hide-message') { $('.cat-btn-group').addClass('cat-hidden'); }
    if (!window._catMesBtnDelegated) {
        window._catMesBtnDelegated = true;
        $(document).on('click', '.cat-mes-trans-btn', function (e) {
            e.stopPropagation();
            const msgId = $(this).data('mesid') || $(this).closest('.mes').attr('mesid');
            const isUser = $(this).closest('.mes').hasClass('mes_user');
            if (msgId === undefined) return;
            // 🚨 beta.15: 팝업이 열려 있으면 재탭 = 팝업 닫기 (토글, 조용히) — 글로우 상태와 무관
            const openPopup = $('.cat-history-popup');
            if (openPopup.length) {
                openPopup.remove();
                $(document).off('click.catHistoryClose touchstart.catHistoryClose');
                $(this).find('.cat-emoji-icon').removeClass('cat-glow-anim').removeAttr('data-cat-glow-start');
                return;
            }
            // 🚨 beta.9: 번역 진행 중 재탭 = 중단 (수동/자동 공통)
            if ($(this).find('.cat-emoji-icon').hasClass('cat-glow-anim')) {
                if (typeof window.__catAbortTranslation === 'function' && window.__catAbortTranslation(msgId)) {
                    catNotify('🔴 번역을 중단했어요.', 'error');
                    $(this).find('.cat-emoji-icon').removeClass('cat-glow-anim').removeAttr('data-cat-glow-start');
                    return;
                }
            }
            processMessageFn(msgId, isUser);
        });
        $(document).on('click', '.cat-mes-revert-btn', function (e) { e.stopPropagation(); const msgId = $(this).data('mesid') || $(this).closest('.mes').attr('mesid'); if (msgId !== undefined) revertMessageFn(msgId); });
        // 🚨 🐟/🍖 클릭 → 바로 번역문 편집 모드 진입
        $(document).on('click', '.cat-mes-edit-btn', function (e) {
            e.stopPropagation();
            const msgId = parseInt($(this).data('mesid') || $(this).closest('.mes').attr('mesid'));
            const mesBlock = $(`.mes[mesid="${msgId}"]`);
            const ctx = SillyTavern?.getContext?.();
            const msg = ctx?.chat?.[msgId];
            if (!msg?.extra?.original_mes) {
                catNotify(`${getThemeEmoji()} 번역 데이터가 없어요.`, "warning");
                return;
            }
            enterTranslatedEdit(mesBlock, msg, msgId);
        });
    }
}

// 🚨 🐟/🍖 → 바로 번역문 편집 모드 진입
function enterTranslatedEdit(mesBlock, msg, msgId) {
    const internalInput = getInternalInputState(msg);
    const savedOriginal = internalInput?.sourceText || msg.extra.original_mes;
    const savedDisplay = msg.extra.display_text;
    const translatedEditText = internalInput?.translatedText || savedDisplay || msg.mes;
    const editChatRef = SillyTavern?.getContext?.()?.chat;
    const editMessageRef = msg;
    const savedSwipeId = msg.swipe_id;
    if (!editChatRef || editChatRef[msgId] !== editMessageRef) return;
    const editSession = beginTranslatedEditSession(
        msgId,
        editChatRef,
        editMessageRef,
        savedSwipeId,
        savedOriginal,
        savedDisplay
    );
    if (!editSession) return;

    // 🚨 편집 모드 마킹
    mesBlock.data('cat-edit-type', 'translated');

    // ST 편집 모드 진입
    const stEditBtn = mesBlock.find('.mes_edit');
    if (stEditBtn.length) stEditBtn.trigger('click');

    // textarea 나타난 후 번역문 삽입
    setTimeout(() => {
        const activeMessage = getTranslatedEditMessage(editSession);
        if (!activeMessage) {
            clearTranslatedEditSession(msgId, editSession);
            mesBlock.removeData('cat-edit-type').removeData('cat-edit-active').removeData('cat-edit-display').removeData('cat-edit-original');
            return;
        }
        const editArea = mesBlock.find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible').first();
        if (!editArea.length) {
            clearTranslatedEditSession(msgId, editSession);
            mesBlock.removeData('cat-edit-type');
            return;
        }

        editArea.off('input.cattranslatededit').on('input.cattranslatededit', function() {
            if (_translatedEditSessions.get(editSession.key) === editSession) {
                editSession.capturedText = $(this).val();
            }
        });
        setTextareaValue(editArea[0], translatedEditText);
        catNotify(
            internalInput
                ? `${getCompletionEmoji()} AI 전달문(${internalInput.targetLang}) 편집 모드`
                : `${getCompletionEmoji()} 번역문 편집 모드`,
            "success"
        );

        // 🚨 편집 닫힘 감지
        const _editWatcher = setInterval(() => {
            const ctx = SillyTavern?.getContext?.();
            const freshMsg = getTranslatedEditMessage(editSession);
            if (!ctx || !freshMsg) {
                clearInterval(_editWatcher);
                clearTranslatedEditSession(msgId, editSession);
                mesBlock.removeData('cat-edit-type').removeData('cat-edit-active').removeData('cat-edit-display').removeData('cat-edit-original');
                return;
            }
            const stillEditing = mesBlock.find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible').length > 0;
            if (!stillEditing) {
                clearInterval(_editWatcher);
                const currentMes = freshMsg.mes;
                const capturedTranslation = editSession.saveRequested &&
                    typeof editSession.capturedText === 'string'
                    ? editSession.capturedText
                    : currentMes;
                if (internalInput) {
                    if (editSession.saveRequested && capturedTranslation.trim()) {
                        applyInternalInputState(
                            freshMsg,
                            internalInput.sourceText,
                            capturedTranslation,
                            internalInput.targetLang
                        );
                        console.log(`[CAT] 🐟 내부 전달문 편집 저장 → AI 컨텍스트 갱신 #${msgId}`);
                    } else {
                        applyInternalInputState(
                            freshMsg,
                            internalInput.sourceText,
                            internalInput.translatedText,
                            internalInput.targetLang
                        );
                        console.log(`[CAT] 🐟 내부 전달문 편집 취소 → 기존 전달문 재적용 #${msgId}`);
                    }
                    clearTranslatedEditSession(msgId, editSession);
                    mesBlock.removeData('cat-edit-type').removeData('cat-edit-active').removeData('cat-edit-display').removeData('cat-edit-original');
                    mesBlock.attr('data-cat-translated', 'true');
                    ctx.updateMessageBlock(msgId, freshMsg);
                    try {
                        const pending = ctx.saveChat?.();
                        if (pending?.catch) pending.catch(e => console.warn('[CAT] 내부 전달문 편집 저장 실패:', e));
                    } catch (e) {
                        console.warn('[CAT] 내부 전달문 편집 저장 실패:', e);
                    }
                    return;
                }
                const translationWasSaved = editSession.saveRequested || currentMes !== savedOriginal;
                if (!freshMsg.extra) freshMsg.extra = {};
                if (translationWasSaved && capturedTranslation !== savedOriginal) {
                    // 번역문 수정 후 저장 → display_text 갱신, 원문 보존
                    freshMsg.extra.display_text = capturedTranslation;
                    freshMsg.extra.original_mes = savedOriginal;
                    freshMsg.mes = savedOriginal;
                    console.log(`[CAT] 🐟 번역문 편집 저장 → display_text 갱신, 원문 보존 #${msgId}`);
                } else {
                    // 수정 없이 닫기 → 기존 번역문 재적용
                    if (freshMsg.extra) {
                        freshMsg.extra.display_text = savedDisplay;
                        freshMsg.extra.original_mes = savedOriginal;
                    }
                    console.log(`[CAT] 🐟 번역문 편집 취소 → 기존 번역문 재적용 #${msgId}`);
                }
                if (freshMsg.swipe_id !== undefined) {
                    freshMsg.extra.cat_swipe_id = freshMsg.swipe_id;
                    if (!freshMsg.extra.swipe_translations) freshMsg.extra.swipe_translations = {};
                    freshMsg.extra.swipe_translations[freshMsg.swipe_id] = {
                        original_mes: savedOriginal,
                        display_text: freshMsg.extra.display_text
                    };
                }
                clearTranslatedEditSession(msgId, editSession);
                mesBlock.removeData('cat-edit-type').removeData('cat-edit-active').removeData('cat-edit-display').removeData('cat-edit-original');
                mesBlock.attr('data-cat-translated', 'true');
                ctx.updateMessageBlock(msgId, freshMsg);
                try {
                    const pending = ctx.saveChat?.();
                    if (pending?.catch) pending.catch(e => console.warn('[CAT] 번역문 편집 저장 실패:', e));
                } catch (e) {
                    console.warn('[CAT] 번역문 편집 저장 실패:', e);
                }
            }
        }, 300);
    }, 350);
}

// 🚨 디버그 팝업: 마지막 번역 요청/응답 표시
function showDebugPopup() {
    $('.cat-debug-overlay').remove();
    const log = getLastDebugLog();
    const escapeDebugHtml = value => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const isLabBuild = CAT_BUILD_CHANNEL === 'lab';
    const debugProduct = isLabBuild ? '🐱🔬 Cat Translator Lab' : '🐱 Cat Translator';
    const ts = log?.timestamp || '-';
    const mode = log?.mode || '(없음)';
    const model = log?.model || '(없음)';
    const error = log?.error || '(에러 없음)';
    const assembly = log?.assembly || '(조립 없음)';
    const glossary = log?.glossary || '(사전 보정 없음)';
    const recovery = log?.recovery || '(복구 없음)';
    const notes = log?.notes || '(참고 없음)';
    const prompt = log?.prompt ? (log.prompt.length > 800 ? log.prompt.substring(0, 800) + '...(생략)' : log.prompt) : '(아직 요청 없음)';
    const raw = log?.rawResponse ? (log.rawResponse.length > 800 ? log.rawResponse.substring(0, 800) + '...(생략)' : log.rawResponse) : '(아직 LLM 응답 없음)';
    const cleaned = log?.cleaned ? (log.cleaned.length > 800 ? log.cleaned.substring(0, 800) + '...(생략)' : log.cleaned) : '(없음)';
    const thought = log?.thought ? (log.thought.length > 300 ? log.thought.substring(0, 300) + '...(생략)' : log.thought) : null;
    const stats = getTranslationStats();
    const sessionStatsLine = `세션 통계: 요청 ${stats.requests} · API 호출 ${stats.apiCalls} · 재시도 ${stats.retries} (검증 ${stats.validationRetries} · 통신 ${stats.transportRetries}) · 캐시 ${stats.cacheHits}`;
    const resultStatsLine = `결과 통계: 정상 ${stats.success} · 부분병기 ${stats.partialBilingual} · 병기미달 ${stats.bilingualBelowTarget} · 실패 ${stats.hardFail} · 중단 ${stats.aborted} · 생략 ${stats.skipped} · 병기조립 ${stats.bilingualAssemblies} · 사전보정 ${stats.glossaryEnforcements}`;

    const overlay = $(`
    <dialog class="cat-debug-overlay" style="background:rgba(0,0,0,0.6); z-index:2147483647; display:none;">
        <div class="cat-debug-modal" style="background:var(--SmartThemeBodyColor, #222); color:var(--SmartThemeEmColor, #fff);">
            <div class="cat-debug-header">
                <div class="cat-debug-title" style="font-size:1.1em; font-weight:bold;">${escapeDebugHtml(debugProduct)} 마지막 LLM 응답 / 에러 로그</div>
                <span class="cat-debug-close" style="cursor:pointer; font-size:1.5em; opacity:0.6; padding:4px 8px;">✕</span>
            </div>
            <div class="cat-debug-body">
            <div style="background:rgba(255,100,100,0.1); border:1px solid rgba(255,100,100,0.3); border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; margin-bottom:4px;">📌 에러 정보</div>
                <div style="font-size:0.85em; opacity:0.8;">시각: ${escapeDebugHtml(ts)}<br>에러: ${escapeDebugHtml(error)}<br>병기 조립: ${escapeDebugHtml(assembly)}<br>사전: ${escapeDebugHtml(glossary)}<br>복구: ${escapeDebugHtml(recovery)}<br>참고: ${escapeDebugHtml(notes)}</div>
            </div>
            <div style="background:rgba(100,180,255,0.1); border:1px solid rgba(100,180,255,0.3); border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; margin-bottom:4px;">🔑 API 호출 상태</div>
                <div style="font-size:0.85em; opacity:0.8;">모드: ${escapeDebugHtml(mode)}<br>모델: ${escapeDebugHtml(model)}<br>${escapeDebugHtml(sessionStatsLine)}<br>${escapeDebugHtml(resultStatsLine)}</div>
            </div>
            <div style="background:rgba(255,200,50,0.1); border:1px solid rgba(255,200,50,0.3); border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; margin-bottom:4px;">📤 보낸 프롬프트 (${(log?.prompt || '').length}자)</div>
                <div style="font-size:0.8em; opacity:0.8; white-space:pre-wrap; word-break:break-all; max-height:200px; overflow-y:auto; font-family:monospace;">${escapeDebugHtml(prompt)}</div>
            </div>
            <div style="background:rgba(100,255,100,0.1); border:1px solid rgba(100,255,100,0.3); border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; margin-bottom:4px;">📋 Raw LLM 응답 (${(log?.rawResponse || '').length}자)</div>
                <div style="font-size:0.8em; opacity:0.8; white-space:pre-wrap; word-break:break-all; max-height:200px; overflow-y:auto; font-family:monospace;">${escapeDebugHtml(raw)}</div>
            </div>
            ${thought ? `<div style="background:rgba(200,100,255,0.1); border:1px solid rgba(200,100,255,0.3); border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; margin-bottom:4px;">🧠 사고 과정</div>
                <div style="font-size:0.8em; opacity:0.8; white-space:pre-wrap; word-break:break-all; max-height:150px; overflow-y:auto; font-family:monospace;">${escapeDebugHtml(thought)}</div>
            </div>` : ''}
            <div style="background:rgba(100,200,255,0.1); border:1px solid rgba(100,200,255,0.3); border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; margin-bottom:4px;">✨ 후처리 결과 (${(log?.cleaned || '').length}자)</div>
                <div style="font-size:0.8em; opacity:0.8; white-space:pre-wrap; word-break:break-all; max-height:200px; overflow-y:auto; font-family:monospace;">${escapeDebugHtml(cleaned)}</div>
            </div>
            <div style="display:flex; gap:8px; margin-bottom:8px;">
                <button class="cat-debug-copy menu_button" style="flex:1;">📋 복사</button>
                <button class="cat-debug-close menu_button" style="flex:1;">닫기</button>
            </div>
            <div class="cat-debug-manual-copy" style="display:none; margin:8px 0;">
                <div style="font-size:0.85em; margin-bottom:6px;">자동 복사가 차단됐어요. 아래 상자를 길게 눌러 전체 선택 후 복사해주세요.</div>
                <textarea readonly style="box-sizing:border-box; width:100%; min-height:150px; resize:vertical; font-family:monospace; font-size:16px;"></textarea>
            </div>
            <div style="text-align:center; font-size:0.8em; opacity:0.5;">💡 이 로그를 복사해서 보여주면 정확한 원인 파악 가능!</div>
            </div>
        </div>
    </dialog>`);

    $('body').append(overlay);
    const syncDebugViewport = () => {
        const viewport = window.visualViewport;
        const top = Math.max(0, viewport?.offsetTop || 0);
        const left = Math.max(0, viewport?.offsetLeft || 0);
        const width = Math.max(1, viewport?.width || window.innerWidth);
        const height = Math.max(1, viewport?.height || window.innerHeight);
        overlay[0].style.setProperty('--cat-debug-vv-top', `${top}px`);
        overlay[0].style.setProperty('--cat-debug-vv-left', `${left}px`);
        overlay[0].style.setProperty('--cat-debug-vv-width', `${width}px`);
        overlay[0].style.setProperty('--cat-debug-vv-height', `${height}px`);
    };
    const removeViewportListeners = () => {
        window.visualViewport?.removeEventListener('resize', syncDebugViewport);
        window.visualViewport?.removeEventListener('scroll', syncDebugViewport);
        window.removeEventListener('resize', syncDebugViewport);
    };
    const closeOverlay = () => {
        removeViewportListeners();
        if (overlay[0]?.open && typeof overlay[0].close === 'function') overlay[0].close();
        overlay.remove();
    };
    syncDebugViewport();
    window.visualViewport?.addEventListener('resize', syncDebugViewport);
    window.visualViewport?.addEventListener('scroll', syncDebugViewport);
    window.addEventListener('resize', syncDebugViewport);
    try {
        if (typeof overlay[0]?.showModal !== 'function') throw new Error('dialog unsupported');
        overlay[0].showModal();
        overlay.css('display', 'block');
    } catch (e) {
        overlay.attr('open', 'open').css('display', 'block');
    }
    requestAnimationFrame(syncDebugViewport);
    overlay.on('cancel', (e) => { e.preventDefault(); closeOverlay(); });
    overlay.find('.cat-debug-close').on('click', closeOverlay);
    overlay.on('click', (e) => { if ($(e.target).hasClass('cat-debug-overlay')) closeOverlay(); });
    overlay.find('.cat-debug-copy').on('click', async () => {
        const attemptLines = Array.isArray(log?.attempts) && log.attempts.length
            ? log.attempts.map((a, i) => `${i + 1}차 [${a.time}] (${a.path}) ${a.reason}${a.detail ? '\n    ' + String(a.detail).replace(/\n/g, '\n    ') : ''}`).join('\n')
            : null;
        const apiAttemptLines = (log?.requestTiming?.attempts || []).map(a =>
            `${a.attempt}차 ${a.path} · ${((a.elapsedMs || 0) / 1000).toFixed(1)}초 · ${a.status || 'unknown'} · 출력상한 ${a.outputLimit ?? '-'}`
        ).join('\n');
        const copyText = `[${debugProduct} 디버그 로그]\n버전: ${CAT_BETA_VERSION}\n${sessionStatsLine}\n${resultStatsLine}\n시각: ${ts}\n모드: ${mode}\n모델: ${model}\n에러: ${error}\n병기 조립: ${assembly}\n사전: ${glossary}\n복구: ${recovery}\n참고: ${notes}${log?.validationDetail ? '\n\n--- 검증 상세 ---\n' + log.validationDetail : ''}${attemptLines ? '\n\n--- 검증 이력 ---\n' + attemptLines : ''}${apiAttemptLines ? '\n\n--- API 시도별 대기 ---\n' + apiAttemptLines : ''}\n\n--- 프롬프트 ---\n${log?.prompt || '없음'}\n\n--- LLM 응답 ---\n${log?.rawResponse || '없음'}\n\n--- 후처리 결과 ---\n${log?.cleaned || '없음'}${thought ? '\n\n--- 사고 과정 ---\n' + thought : ''}`;
        const ok = await catCopyToClipboard(copyText);
        if (ok) {
            overlay.find('.cat-debug-manual-copy').hide();
            catNotify('📋 디버그 로그 복사 완료!', 'success');
            return;
        }
        const manual = overlay.find('.cat-debug-manual-copy');
        const textarea = manual.find('textarea');
        textarea.val(copyText);
        manual.show();
        requestAnimationFrame(() => {
            const element = textarea[0];
            element?.focus({ preventScroll: true });
            element?.select();
            element?.setSelectionRange(0, element.value.length);
            element?.scrollIntoView({ block: 'nearest' });
        });
        catNotify('자동 복사가 차단되어 수동 복사 상자를 열었어요.', 'warning');
    });
}

// 비보안 HTTP(Tailscale/LAN)는 Clipboard API가 보여도 권한 거절 뒤 사용자 활성화가
// 만료될 수 있다. 이 경우 처음부터 동기식 execCommand를 사용하고, 실패하면 호출부가
// 전체 로그가 든 수동 복사 상자를 노출한다.
export async function catCopyToClipboard(text) {
    try {
        if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* 폴백으로 진행 */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('aria-hidden', 'true');
        ta.style.position = 'fixed';
        ta.style.left = '0';
        ta.style.top = '0';
        ta.style.width = '2px';
        ta.style.height = '2px';
        ta.style.padding = '0';
        ta.style.border = '0';
        ta.style.opacity = '0.01';
        ta.style.fontSize = '16px';
        document.body.appendChild(ta);
        ta.focus({ preventScroll: true });
        ta.select();
        ta.setSelectionRange(0, ta.value.length); // iOS 대응
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (_) {
        return false;
    }
}

function showBulkPopup(event, settings, stContext, processMessageFn) {
    $('.cat-bulk-popup').remove();
    $(document).off('click.catBulkClose touchstart.catBulkClose');
    
    const popup = $(`<div class="cat-bulk-popup">
        <div class="cat-bulk-option" data-count="all">📋 전체 번역</div>
        <div class="cat-bulk-option" data-count="20">🦁 최근 20개</div>
        <div class="cat-bulk-option" data-count="15">🐯 최근 15개</div>
        <div class="cat-bulk-option" data-count="10">🐱 최근 10개</div>
        <div class="cat-bulk-option" data-count="5">🐭 최근 5개</div>
        <div class="cat-bulk-option" data-count="custom">✏️ 직접 입력...</div>
    </div>`);
    
    const btn = document.getElementById('cat-bulk-btn');
    if (!btn) return;
    
    $('body').append(popup);
    const rect = btn.getBoundingClientRect();
    
    // 번개 아이콘 바로 위에 절대 좌표로 고정
    popup.css({ 
        position: 'fixed', 
        top: (rect.top - popup.outerHeight() - 10) + 'px', 
        left: Math.max(10, rect.left - 40) + 'px', 
        zIndex: 2147483647 
    });
    
    // 터치 중복 방지 (무적 시간)
    let _bulkJustOpened = true;
    setTimeout(() => { _bulkJustOpened = false; }, 300);
    
    popup.on('touchstart click', (e) => { e.stopPropagation(); });
    
    popup.find('.cat-bulk-option').on('click touchend', async function (e) {
        e.preventDefault(); e.stopPropagation();
        let count = $(this).data('count');
        if (count === 'custom') {
            popup.remove();
            $(document).off('click.catBulkClose touchstart.catBulkClose');
            const input = prompt('번역할 최근 메시지 수를 입력하세요:', '10');
            if (!input || isNaN(parseInt(input))) return;
            count = parseInt(input);
            if (count <= 0) return;
        }
        popup.remove();
        $(document).off('click.catBulkClose touchstart.catBulkClose');
        await executeBulkTranslation(count, settings, stContext, processMessageFn);
    });
    
    setTimeout(() => {
        $(document).on('click.catBulkClose touchstart.catBulkClose', (e) => {
            if (_bulkJustOpened) return;
            if (!$(e.target).closest('.cat-bulk-popup, #cat-bulk-btn').length) {
                popup.remove();
                $(document).off('click.catBulkClose touchstart.catBulkClose');
            }
        });
    }, 300);
}

async function executeBulkTranslation(count, settings, stContext, processMessageFn) {
    const BULK_CONCURRENCY = 2;  // 🚨 동시 워커 수 (함수 최상단 선언)
    const bulkChatRef = SillyTavern?.getContext?.()?.chat || stContext.chat;
    if (!bulkChatRef) return;
    const allMes = $('.mes'); let targets = []; let originalCount = 0;
    if (count === 'all') { allMes.each(function () { targets.push($(this)); }); } else { const num = parseInt(count); const start = Math.max(0, allMes.length - num); allMes.slice(start).each(function () { targets.push($(this)); }); }
    originalCount = targets.length;
    targets = targets.filter(el => { const msgId = parseInt(el.attr('mesid'), 10); const msg = bulkChatRef[msgId]; return msg && !msg.extra?.display_text; });
    const skipped = originalCount - targets.length;
    if (targets.length === 0) { catNotify(`${getThemeEmoji()} 번역할 메시지가 없습니다. (${skipped}개 이미 번역됨)`, "warning"); return; }

    const controller = new AbortController();
    bulkAbortController = controller;
    const total = targets.length; let completed = 0;
    $('#cat-bulk-btn').html('<span class="cat-emoji-icon" style="filter:grayscale(1);">⚡</span>');
    const abortHandler = () => controller.abort();
    $('#cat-bulk-btn').off('click').on('click', (e) => { e.preventDefault(); abortHandler(); });

    const progressEl = catNotifyProgress(`${getThemeEmoji()} 벌크 번역 중... (0/${total}) [클릭시 중단]`, abortHandler);
    const bulkStartTime = performance.now();
    console.log(`[CAT] ⚡ 벌크 시작: ${total}개 메시지, 동시 ${BULK_CONCURRENCY}개 병렬`);
    // 🚨 병렬 처리: 동시 2개 워커로 벌크 속도 ~2배 향상
    let taskIdx = 0;
    const bulkWorker = async () => {
        while (taskIdx < targets.length) {
            const liveChat = SillyTavern?.getContext?.()?.chat || stContext.chat;
            if (controller.signal.aborted || liveChat !== bulkChatRef) {
                controller.abort();
                return;
            }
            const i = taskIdx++;
            if (i >= targets.length) return;
            const el = targets[i];
            const msgId = el.attr('mesid'); const isUser = el.hasClass('mes_user');
            await processMessageFn(msgId, isUser, controller.signal, true);
            const currentChat = SillyTavern?.getContext?.()?.chat || stContext.chat;
            if (controller.signal.aborted || currentChat !== bulkChatRef) {
                controller.abort();
                return;
            }
            completed++;
            if (progressEl.length) progressEl.text(`${getThemeEmoji()} 벌크 번역 중... (${completed}/${total}) [클릭시 중단]`);
            if (!controller.signal.aborted) await new Promise(r => setTimeout(r, 150));
        }
    };
    await Promise.all(Array.from({ length: BULK_CONCURRENCY }, () => bulkWorker()));
    const bulkElapsed = ((performance.now() - bulkStartTime) / 1000).toFixed(1);
    console.log(`[CAT] ⚡ 벌크 완료: ${completed}/${total}개, ${bulkElapsed}초 소요`);
    progressEl.remove(); $('#cat-bulk-btn').html('<span class="cat-emoji-icon">⚡</span>');
    $('#cat-bulk-btn').off('click').on('click', (e) => { e.preventDefault(); e.stopPropagation(); showBulkPopup(e, settings, stContext, processMessageFn); });
    if (controller.signal.aborted) catNotify(`🔴 번역 중단됨 (${completed}개 완료)`, "error"); else catNotify(`${getCompletionEmoji()} 벌크 완료! ${completed}개 번역${skipped > 0 ? ', ' + skipped + '개 스킵' : ''}`, "success");
    if (bulkAbortController === controller) bulkAbortController = null;
}

export async function showHistoryPopup(originalText, targetLang, anchorEl, onSelect, modelKey = 'default', prevDisplay = null) {
    // 🚨 v1.1.0 보안: 번역문(모델 출력)을 HTML 삽입 전 이스케이프 — 팝업은 DOMPurify 미경유라 필수
    // (반드시 함수 최상단: renderItem이 아래에서 즉시 호출하므로 늦게 선언하면 TDZ ReferenceError로 팝업 전체가 죽음)
    const escapePopupHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    $('.cat-history-popup').remove();
    const history = await getHistory(originalText, targetLang, modelKey);
    // 🚨 beta.13: 재번역 탭 = 무조건 팝업 — 히스토리가 적어도(0~2개) 팝업을 띄우고,
    // 번역은 "새로 번역"을 명시적으로 눌러야만 시작 (히스토리 보려다 재번역 시작되던 문제 해결)
    const showHistoryItems = history.length >= 1;

    const sorted = [...history].sort((a, b) => { if (a.pinned && !b.pinned) return -1; if (!a.pinned && b.pinned) return 1; return b.time - a.time; }).slice(0, 15);
    const renderItem = (h, i, hidden) => {
        const pinClass = h.pinned ? 'cat-pinned' : ''; const pinIcon = h.pinned ? '📌' : '📍'; const truncated = h.text.length > 80 ? h.text.substring(0, 80) + '...' : h.text;
        return `<div class="cat-history-item ${pinClass}${hidden ? ' cat-history-hidden' : ''}" data-idx="${i}"${hidden ? ' style="display:none;"' : ''}><span class="cat-history-text" data-text="${encodeURIComponent(h.text)}">${escapePopupHtml(truncated)}</span><span class="cat-history-pin" data-text="${encodeURIComponent(h.text)}">${pinIcon}</span><span class="cat-history-del" data-text="${encodeURIComponent(h.text)}" title="이 번역 삭제">✕</span></div>`;
    };
    // 🚨 beta.16: 프리뷰 3개 + 나머지는 더보기로 접기
    let items = '';
    if (showHistoryItems) {
        items = sorted.slice(0, 3).map((h, i) => renderItem(h, i, false)).join('');
        const hiddenPart = sorted.slice(3);
        if (hiddenPart.length > 0) {
            items += hiddenPart.map((h, i) => renderItem(h, i + 3, true)).join('');
            items += `<div class="cat-history-item cat-history-more">▾ 지난 번역 ${hiddenPart.length}개 더보기</div>`;
        }
    }
    // 🚨 beta.9: 직전 번역 복귀 항목 — 최상단 고정
    if (prevDisplay) {
        const prevTrunc = prevDisplay.length > 80 ? prevDisplay.substring(0, 80) + '...' : prevDisplay;
        items = `<div class="cat-history-item cat-history-prev" data-text="${encodeURIComponent(prevDisplay)}">↩️ 직전 번역: <span class="cat-history-prev-preview">${$('<span>').text(prevTrunc).html()}</span></div>` + items;
    }
    items += `<div class="cat-history-item cat-history-new">🔄 새로 번역</div>`;

    const popup = $(`<div class="cat-history-popup">${items}</div>`);
    // 🚨 beta.15: 팝업 = 선택 대기 상태 → 글로우(작업 중 신호)는 팝업 열림과 동시에 끔
    // 🚨 beta.12: 모바일 고스트 클릭 방어 — 팝업이 여는 탭의 합성 click(~300ms 지연)에
    // 맞아 항목이 즉시 실행되던 문제. 생성 직후 400ms 동안 항목 클릭 무시
    const popupOpenedAt = Date.now();
    const ghostGuard = () => Date.now() - popupOpenedAt < 400;
    // 🚨 beta.14: 팝업이 닫히는 모든 경로에서 버튼 글로우 정리 (안 끄면 60초까지 계속 돎)
    const stopAnchorGlow = () => anchorEl.find('.cat-emoji-icon').removeClass('cat-glow-anim').removeAttr('data-cat-glow-start');
    // 🚨 beta.16: 팝업 제거 시 document 닫기 핸들러도 반드시 해제 — 잔존하면 다음 탭의
    // touchstart를 가로채 글로우를 먼저 꺼버려 "번역 중단"이 통째로 무력화됨
    const closePopup = () => { popup.remove(); $(document).off('click.catHistoryClose touchstart.catHistoryClose'); };
    
    const rect = anchorEl[0].getBoundingClientRect();
    const popupWidth = 280;
    let leftPos = rect.left;
    
    if (leftPos + popupWidth > window.innerWidth - 8) {
        leftPos = window.innerWidth - popupWidth - 8;
    }
    leftPos = Math.max(8, leftPos);
    
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow > 200) {
        popup.css({ position: 'fixed', top: (rect.bottom + 4) + 'px', left: leftPos + 'px', zIndex: 2147483647 });
    } else {
        popup.css({ position: 'fixed', bottom: (window.innerHeight - rect.top + 4) + 'px', left: leftPos + 'px', zIndex: 2147483647 });
    }
    
    $('body').append(popup);
    stopAnchorGlow();

    popup.find('.cat-history-text').on('click', function () { if (ghostGuard()) return; const text = decodeURIComponent($(this).data('text')); stopAnchorGlow(); onSelect(text, false); closePopup(); });
    popup.find('.cat-history-pin').on('click', async function (e) { e.stopPropagation(); if (ghostGuard()) return; const text = decodeURIComponent($(this).data('text')); await togglePin(originalText, targetLang, text, modelKey); closePopup(); showHistoryPopup(originalText, targetLang, anchorEl, onSelect, modelKey, prevDisplay); });
    
    let newTransBusy = false;
    // 🚨 beta.16: 더보기 — 숨긴 항목 펼치기
    popup.find('.cat-history-more').on('click', function() {
        if (ghostGuard()) return;
        popup.find('.cat-history-hidden').show();
        $(this).remove();
    });
    // 🚨 beta.16: 항목 개별 삭제 (✕)
    popup.find('.cat-history-del').on('click', async function (e) {
        e.stopPropagation();
        if (ghostGuard()) return;
        const text = decodeURIComponent($(this).data('text'));
        await deleteHistoryItem(originalText, targetLang, text, modelKey);
        closePopup();
        showHistoryPopup(originalText, targetLang, anchorEl, onSelect, modelKey, prevDisplay);
    });
    popup.find('.cat-history-prev').on('click', function() {
        if (ghostGuard()) return;
        const prevText = decodeURIComponent($(this).attr('data-text') || '');
        stopAnchorGlow();
        closePopup();
        if (prevText) onSelect(prevText, false);
    });
    popup.find('.cat-history-new').on('click', () => {
        if (ghostGuard()) return;
        if (newTransBusy) return;
        newTransBusy = true;
        catNotify(`${getThemeEmoji()} 새로운 번역 생성 중...`, "success");
        onSelect(null, true);
        closePopup();
    });

    setTimeout(() => {
        $(document).on('click.catHistoryClose touchstart.catHistoryClose', (e) => {
            // 팝업이 이미 사라졌으면 (새로 번역 등) 글로우 건드리지 말고 핸들러만 해제
            if (!$('.cat-history-popup').length) {
                $(document).off('click.catHistoryClose touchstart.catHistoryClose');
                return;
            }
            if (!$(e.target).closest('.cat-history-popup').length) {
                stopAnchorGlow();
                closePopup();
            }
        });
    }, 500);
    return true;
}

export function setupDragDictionary(settings, saveSettingsFn, getChat = () => []) {
    let pawIcon = null; let _dragDebounce = null;
    const handleSelection = () => {
        clearTimeout(_dragDebounce);
        _dragDebounce = setTimeout(() => {
            const selection = window.getSelection(); const selectedText = selection?.toString()?.trim(); $('.cat-drag-paw').remove();
            if (!selectedText || selectedText.length === 0 || selectedText.length > 100) return;
            const anchorNode = selection.anchorNode; if (!anchorNode || !$(anchorNode).closest('#chat').length) return;
            const mes = $(anchorNode).closest('.mes');
            if (!mes.length || $(selection.focusNode).closest('.mes')[0] !== mes[0]) return;
            const msg = getChat()?.[Number(mes.attr('mesid'))];
            const internal = getInternalInputState(msg);
            const originalText = internal?.translatedText || msg?.extra?.original_mes || msg?.mes || '';
            let range; try { range = selection.getRangeAt(0); } catch (e) { return; }
            const rect = range.getBoundingClientRect(); if (rect.width === 0) return;
            pawIcon = $(`<div class="cat-drag-paw" title="사전 등록">🐾</div>`); const isMobile = window.innerWidth < 768; const topOffset = isMobile ? rect.bottom + 12 : rect.bottom + 4;
            pawIcon.css({ position: 'fixed', top: Math.min(topOffset, window.innerHeight - 50) + 'px', left: Math.max(8, rect.left + rect.width / 2 - 14) + 'px', zIndex: 99999 });
            $('body').append(pawIcon);
            pawIcon.on('click', (ev) => { ev.stopPropagation(); showDragDictPopup(selectedText, rect, settings, saveSettingsFn, originalText); pawIcon.remove(); });
            setTimeout(() => pawIcon?.remove(), 8000);
        }, 200);
    };
    document.addEventListener('selectionchange', handleSelection); $(document).on('mouseup touchend', '#chat', handleSelection);
    $(document).on('mousedown', (e) => { if (!$(e.target).closest('.cat-drag-paw, .cat-drag-popup').length) { $('.cat-drag-paw, .cat-drag-popup').remove(); } });
}

function showDragDictPopup(selectedText, rect, settings, saveSettingsFn, originalText = '') {
    $('.cat-drag-popup').remove();
    const reverse = /[가-힣]/.test(selectedText) && /[A-Za-z]/.test(originalText);
    const match = reverse ? suggestDictionarySource(selectedText, originalText, settings.dictionary) : { source: selectedText, candidates: [] };
    const popup = $(`<div class="cat-drag-popup"><div class="cat-drag-header"></div><label>원문<input type="text" class="cat-drag-source text_pole" placeholder="원문 이름 입력"></label><select class="cat-drag-candidates text_pole"><option value="">원문 후보 선택</option></select><label>번역어<input type="text" class="cat-drag-input text_pole" placeholder="번역어 입력"></label><div class="cat-drag-actions"><button class="cat-drag-register menu_button">등록</button><button class="cat-drag-cancel menu_button">취소</button></div></div>`);
    popup.find('.cat-drag-header').text(reverse ? '원문 이름 후보를 확인하고 등록하세요' : '사전 등록');
    popup.find('.cat-drag-source').val(match.source);
    popup.find('.cat-drag-input').val(reverse ? selectedText : '');
    const picker = popup.find('.cat-drag-candidates');
    for (const candidate of match.candidates) picker.append($('<option>').val(candidate).text(candidate));
    if (!match.candidates.length) picker.hide();
    picker.on('change', () => { if (picker.val()) popup.find('.cat-drag-source').val(picker.val()); });
    const isMobile = window.innerWidth < 768; if (isMobile) { popup.css({ position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)', zIndex: 99999, width: 'calc(100vw - 32px)', maxWidth: '320px' }); } else { popup.css({ position: 'fixed', top: (rect.bottom + 8) + 'px', left: Math.max(8, rect.left - 20) + 'px', zIndex: 99999 }); }
    $('body').append(popup); popup.find('.cat-drag-input').focus();
    const doRegister = () => {
        const sourceWord = popup.find('.cat-drag-source').val().trim();
        const transWord = popup.find('.cat-drag-input').val().trim(); if (!transWord) return;
        if (!sourceWord || /[=\r\n]/.test(sourceWord) || /[\r\n]/.test(transWord)) {
            catNotify('원문 이름과 번역어를 한 줄로 확인해 주세요.', 'warning'); return;
        }
        const existingLines = (settings.dictionary || '').split('\n').filter(l => l.includes('='));
        const isDuplicate = existingLines.some(line => {
            const parts = line.split('=');
            const orig = parts[0].trim().toLowerCase();
            const trans = parts.slice(1).join('=').trim().toLowerCase();
            return orig === sourceWord.toLowerCase() && trans === transWord.toLowerCase();
        });
        if (isDuplicate) {
            catNotify('⚠️ 동일한 사전 항목이 이미 등록되어 있습니다.', "warning");
            popup.remove(); return;
        }
        const newEntry = `${sourceWord}=${transWord}`; const current = settings.dictionary || '';
        settings.dictionary = current ? `${current}\n${newEntry}` : newEntry; $('#ct-dictionary').val(settings.dictionary);
        $('#ct-dict-reset').text('📬');
        saveSettingsFn(); catNotify('🐾 사전 등록 완료!', "success"); popup.remove();
    };
    popup.find('.cat-drag-register').on('click', doRegister); popup.find('.cat-drag-input').on('keydown', (e) => { if (e.key === 'Enter') doRegister(); if (e.key === 'Escape') popup.remove(); }); popup.find('.cat-drag-cancel').on('click', () => popup.remove());
}

// 🚨 원문 수정 감지 → 재번역 안내 토스트 (afterEditMode === 'notify')
function showRetranslatePrompt(msgId, processMessageFn) {
    $('.cat-retranslate-toast').remove();
    const toast = $(`
        <div class="cat-retranslate-toast" style="position:fixed; bottom:80px; left:50%; transform:translateX(-50%); z-index:99999; background:var(--SmartThemeBlurTintColor,#333); color:var(--SmartThemeBodyColor,#fff); border:1px solid var(--ca-accent,#888); border-radius:10px; padding:10px 14px; box-shadow:0 4px 16px rgba(0,0,0,0.3); display:flex; align-items:center; gap:10px; max-width:90vw;">
            <span>${getThemeEmoji()} 원문이 수정되었어요. 재번역할까요?</span>
            <button class="cat-retranslate-yes menu_button" style="padding:4px 10px; margin:0;">재번역</button>
            <span class="cat-retranslate-close" style="cursor:pointer; opacity:0.6; padding:0 4px;">✕</span>
        </div>
    `);
    $('body').append(toast);
    toast.find('.cat-retranslate-yes').on('click', () => {
        toast.remove();
        const mesBlock = $(`.mes[mesid="${msgId}"]`);
        const msg = SillyTavern.getContext().chat[msgId];
        if (msg?.extra) delete msg.extra.display_text;
        mesBlock.removeAttr('data-cat-translated');
        processMessageFn(msgId, false, null, false, false);
    });
    toast.find('.cat-retranslate-close').on('click', () => toast.remove());
    setTimeout(() => toast.fadeOut(400, () => toast.remove()), 10000);
}

export function setupMutationObserver(processMessageFn, revertMessageFn, settings, stContext) {
    const chatContainer = document.getElementById('chat'); if (!chatContainer) { setTimeout(() => setupMutationObserver(processMessageFn, revertMessageFn, settings, stContext), 500); return; }
    const pending = new Set();
    let scheduled = null;
    const processChanges = () => {
        scheduled = null;
        const dirty = [...pending].filter(node => node.isConnected !== false);
        pending.clear();
        if (!dirty.length) return;
        const liveContext = SillyTavern?.getContext?.() || stContext;
        injectMessageButtons(processMessageFn, revertMessageFn, dirty);
        injectInputButtons(settings, liveContext, processMessageFn);
        // 🚨 편집 모드 호환: 번역된 메시지의 edit textarea에 display_text 표시
        // ST가 편집 모드 진입 시 data-cat-translated를 제거하므로, msg.extra로 판별
        $(dirty).each(function() {
            const mesBlock = $(this);
            const editArea = mesBlock.find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible').first();
            const msgId = parseInt(mesBlock.attr('mesid'));
            const msg = liveContext.chat[msgId];
            if (!msg) return;
            
            // 번역 데이터가 없는 메시지는 스킵 (백업 데이터도 확인)
            const hasTransData = msg.extra?.original_mes || mesBlock.data('cat-edit-original');
            if (!hasTransData) return;
            
            if (editArea.length > 0 && !mesBlock.data('cat-edit-active')) {
                // 편집 모드 진입: display_text를 백업
                mesBlock.data('cat-edit-active', true);
                if (msg.extra?.display_text) mesBlock.data('cat-edit-display', msg.extra.display_text);
                if (msg.extra?.original_mes) mesBlock.data('cat-edit-original', msg.extra.original_mes);
                const internalInput = getInternalInputState(msg);
                if (internalInput && mesBlock.data('cat-edit-type') !== 'translated') {
                    // ✏️는 원문 편집 버튼이다. 내부 전달문(msg.mes)이 아니라 사용자가
                    // 작성한 한국어 원문을 편집창에 넣고, 저장 후 다시 내부 번역한다.
                    mesBlock.data('cat-edit-type', 'internal-source');
                    mesBlock.data('cat-internal-state', { ...internalInput });
                    mesBlock.data('cat-internal-save-requested', false);
                    setTextareaValue(editArea[0], internalInput.sourceText);
                    console.log(`[CAT] ✏️ 내부 입력 한국어 원문 편집 진입 #${msgId}`);
                }
                
                // 🚨 textarea에 직접 input 리스너 바인딩 (글로벌 Map에 저장)
                const msgIdStr = String(msgId);
                window._catCapturedText = window._catCapturedText || new Map();
                window._catCapturedText.set(msgIdStr, editArea.val()); // 초기값
                editArea.off('input.catedit keyup.catedit').on('input.catedit keyup.catedit', function() {
                    const val = $(this).val();
                    if (val) {
                        window._catCapturedText.set(msgIdStr, val);
                    }
                });
                
                // 🚨 ✓ 버튼에 직접 클릭 핸들러 바인딩 (위임 이벤트 백업)
                // 모바일 ST에서 $(document).on이 안 잡히는 케이스 대응
                const $doneBtn = mesBlock.find('.mes_edit_done, .mes_edit_save, .edit_mes_save, [class*="mes_edit_done"]').first();
                if ($doneBtn.length > 0 && !$doneBtn.data('cat-direct-bound')) {
                    $doneBtn.data('cat-direct-bound', true);
                    $doneBtn.on('click.catdirect', function() {
                        if (mesBlock.data('cat-edit-type') === 'internal-source') {
                            mesBlock.data('cat-internal-save-requested', true);
                        }
                        const directEditChatRef = SillyTavern?.getContext?.()?.chat || stContext.chat;
                        const $ta = mesBlock.find('textarea').first();
                        if ($ta.length > 0) {
                            window._catCapturedText.set(msgIdStr, $ta.val());
                        }
                        const captured = window._catCapturedText.get(msgIdStr);
                        markTranslatedEditSave(msgIdStr, captured, directEditChatRef);
                        console.log(`[CAT] ✓ 직접 핸들러 #${msgIdStr} 캡처: ${captured ? captured.substring(0, 50) : '없음'}`);
                        catNotify(`${getThemeEmoji ? getThemeEmoji() : '🐱'} 편집 저장 #${msgIdStr}`, "info");
                        // index.js의 handleEditSaved를 window에서 호출
                        setTimeout(() => {
                            if (typeof window._catHandleEditSaved === 'function') {
                                window._catHandleEditSaved(msgIdStr, captured, directEditChatRef);
                            }
                        }, 500);
                    });
                }
            } else if (editArea.length === 0 && mesBlock.data('cat-edit-active')) {
                // 편집 모드 종료 - 백업 데이터만 정리 (실제 처리는 index.js handleEditSaved + 폴링이 담당)
                mesBlock.removeData('cat-edit-active');
                
                // 🚨 🐟/🍖 편집 팝업에서 진입한 편집은 _editWatcher가 처리 → 여기서 스킵
                const editType = mesBlock.data('cat-edit-type');
                if (editType === 'translated') return;
                if (editType === 'internal-source') {
                    const savedInternal = mesBlock.data('cat-internal-state');
                    const saveRequested = mesBlock.data('cat-internal-save-requested') === true;
                    mesBlock
                        .removeData('cat-edit-type')
                        .removeData('cat-edit-display')
                        .removeData('cat-edit-original')
                        .removeData('cat-internal-state')
                        .removeData('cat-internal-save-requested');
                    if (!saveRequested && savedInternal) {
                        applyInternalInputState(
                            msg,
                            savedInternal.sourceText,
                            savedInternal.translatedText,
                            savedInternal.targetLang
                        );
                        mesBlock.attr('data-cat-translated', 'true');
                        liveContext.updateMessageBlock(msgId, msg);
                        try {
                            const pending = stContext.saveChat?.();
                            if (pending?.catch) pending.catch(e => console.warn('[CAT] 내부 입력 편집 취소 복구 저장 실패:', e));
                        } catch (e) {
                            console.warn('[CAT] 내부 입력 편집 취소 복구 저장 실패:', e);
                        }
                        console.log(`[CAT] ✏️ 내부 입력 편집 취소 → 기존 한국어 표시/전달문 복구 #${msgId}`);
                    }
                    return;
                }
                
                const savedDisplay = mesBlock.data('cat-edit-display');
                const savedOriginal = mesBlock.data('cat-edit-original');
                mesBlock.removeData('cat-edit-display').removeData('cat-edit-original');
                
                if (savedDisplay && savedOriginal) {
                    // msg.mes가 한국어로 오염되었으면 원문 복원만 (자동 재번역은 index.js handleEditSaved가 담당)
                    const hasKorean = /[가-힣]/.test(msg.mes) && msg.mes.length > 10;
                    if (hasKorean) {
                        if (!msg.extra) msg.extra = {};
                        msg.extra.original_mes = savedOriginal;
                        msg.mes = savedOriginal;
                        msg.extra.display_text = savedDisplay;
                        mesBlock.attr('data-cat-translated', 'true');
                        liveContext.updateMessageBlock(msgId, msg);
                        console.log(`[CAT] 🛡️ 옵저버: 한국어 차단, 원문 보존 #${msgId}`);
                    } else if (msg.mes === savedOriginal) {
                        // 변경 없음 → display_text 재적용
                        if (!msg.extra) msg.extra = {};
                        msg.extra.original_mes = savedOriginal;
                        msg.extra.display_text = savedDisplay;
                        mesBlock.attr('data-cat-translated', 'true');
                        liveContext.updateMessageBlock(msgId, msg);
                    }
                    // 영어 수정된 경우는 handleEditSaved에서 처리 → 여기서는 아무것도 안 함
                }
            }
        });
    };
    const addMessage = node => {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const message = element?.closest?.('.mes');
        if (message) pending.add(message);
    };
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            addMessage(mutation.target);
            for (const node of mutation.addedNodes) {
                addMessage(node);
                for (const message of node.querySelectorAll?.('.mes') || []) pending.add(message);
            }
        }
        // Bound work to changed messages and coalesce streaming DOM updates.
        if (pending.size && scheduled === null) scheduled = setTimeout(processChanges, 50);
    });
    observer.observe(chatContainer, { childList: true, subtree: true });
    injectMessageButtons(processMessageFn, revertMessageFn); injectInputButtons(settings, stContext, processMessageFn); setInterval(() => injectInputButtons(settings, stContext, processMessageFn), 2000);
}
