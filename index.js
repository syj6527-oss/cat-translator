// ============================================================
// 🐱 Translator v1.1.0
// ============================================================
import { extension_settings, getContext } from '../../../../scripts/extensions.js';
import { catNotify, getThemeEmoji, getCompletionEmoji, setTextareaValue, getModelTheme, detectLanguageDirection, getCacheModelKey, buildLiteralDetailsHtml, stripLiteralDetails, analyzeLanguage, isClearlyLanguage, resolveInputTranslationDirection, resolveInputUserPrompt, isSameSourceForEdit, normalizeInternalInputLanguage, resolvePendingInternalInputMatch, shouldRestoreInternalInputDraft, getInternalInputState, applyInternalInputState, clearInternalInputState } from './utils.js';
import { initCache, getCacheStorageMode, deleteCached } from './cache.js';
import { fetchTranslation, gatherContextMessages, gatherInternalInputContextMessages } from './translator.js';
import { resolveMessageEventId, createAutoTranslationScheduler, normalizeContextRange } from './utils.js';
import { setupSettingsPanel, collectSettings, updateCacheStats, injectMessageButtons, injectInputButtons, setupDragDictionary, setupMutationObserver, showHistoryPopup, applyTheme, setSuppressAutoSave, clearPendingAutoSave, abortBulkTranslation, isTranslatedEditActive, markTranslatedEditSave, clearTranslatedEditSessions } from './ui.js';

const EXT_NAME = "cat-translator";
const stContext = getContext();

const defaultSettings = { profile: '', customKey: '', vertexKey: '', vertexProject: '', vertexRegion: 'global', directModel: 'gemini-2.5-flash', customModelName: '', autoMode: 'none', nonGeminiFastMode: 'off', internalInputTranslation: 'off', internalInputLanguage: 'English', bidirectional: 'off', dialogueBilingual: 'off', literalBilingual: 'off', iconVisibility: 'all', targetLang: 'Korean', style: 'normal', temperature: 0.3, maxTokens: 8192, contextRange: 1, commonPrompt: '', narrationPrompt: '', dialoguePrompt: '', userPrompt: '', dictionary: '', retranslateStrength: 'normal', afterEditMode: 'notify', previewTranslate: 'off', previewCleanup: 'off', cotMaskTags: '', inputUserPrompt: '', promptPresets: {}, charPresetMap: {} };
const storedSettings = extension_settings[EXT_NAME] || {};
let settings = Object.assign({}, defaultSettings, storedSettings);
// v1.3.2: 구버전 단일 추가 지시는 적용 범위가 전체였으므로 공통 지침으로 이전한다.
// v1.3.1 시험판에서 단일 지침이 서술 칸으로 잘못 이전된 경우도 공통 칸으로 복구한다.
if (!Object.prototype.hasOwnProperty.call(storedSettings, 'commonPrompt')) {
    const cameFromSplitPreview = storedSettings?._baseline?._v === 3 && !storedSettings.userPrompt;
    settings.commonPrompt = storedSettings.userPrompt || (cameFromSplitPreview ? storedSettings.narrationPrompt : '') || '';
    if (cameFromSplitPreview) settings.narrationPrompt = '';
}
// 🚨 v1.1.4-beta.5: 구글이 지원 종료한 모델이 저장돼 있으면 자동 이관.
// gemini-2.0 계열은 2026-06-01 셧다운 완료 — 호출 시 무조건 실패하며,
// 에러 본문이 안 보이던 구버전에선 "API 키 문제"로 오인되던 원인.
const RETIRED_DIRECT_MODELS = { 'gemini-2.0-flash': 'gemini-3.5-flash', 'gemini-2.0-flash-001': 'gemini-3.5-flash', 'gemini-2.0-flash-lite': 'gemini-3.5-flash' };
if (RETIRED_DIRECT_MODELS[settings.directModel]) {
    console.log(`[CAT] ⚰️ 지원 종료 모델 감지: ${settings.directModel} → ${RETIRED_DIRECT_MODELS[settings.directModel]} 자동 이관`);
    settings.directModel = RETIRED_DIRECT_MODELS[settings.directModel];
}

let _chatSaveTimer = null;
const _translationApplyTokens = new Map();

function getLiveContext() {
    return SillyTavern?.getContext?.() || stContext;
}

function getLiveChat() {
    return getLiveContext()?.chat || stContext.chat;
}

function scheduleChatSave(reason = '') {
    const scheduledContext = getLiveContext();
    const scheduledChat = scheduledContext?.chat;
    clearTimeout(_chatSaveTimer);
    _chatSaveTimer = setTimeout(() => {
        _chatSaveTimer = null;
        try {
            const ctx = getLiveContext();
            if (!scheduledChat || ctx?.chat !== scheduledChat) {
                console.warn(`[CAT] ⏭️ 채팅 전환으로 이전 저장 예약 취소 (${reason || 'unknown'})`);
                return;
            }
            const pending = ctx?.saveChat?.();
            if (pending?.catch) pending.catch(e => console.warn('[CAT] 채팅 저장 실패:', e));
            if (reason) console.log(`[CAT] 💾 번역 상태 저장 예약 완료 (${reason})`);
        } catch (e) {
            console.warn('[CAT] 채팅 저장 실패:', e);
        }
    }, 300);
}

function cancelPendingTranslationWork(reason = '') {
    clearTimeout(_chatSaveTimer);
    _chatSaveTimer = null;
    _translationApplyTokens.clear();
    _internalInputEditTokens.clear();
    if (reason) console.log(`[CAT] 🧹 대기 중인 번역 적용 작업 취소 (${reason})`);
}

function scheduleTranslationVerification(msgId, expected) {
    const token = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const expectedChat = expected.chatRef || getLiveChat();
    _translationApplyTokens.set(msgId, token);

    const verify = (delay) => setTimeout(() => {
        if (_translationApplyTokens.get(msgId) !== token) return;
        const liveContext = getLiveContext();
        if (liveContext?.chat !== expectedChat) return;
        const current = expectedChat?.[msgId];
        if (!current || current.swipe_id !== expected.swipeId) return;
        const sourceStillMatches = current.extra?.original_mes === expected.source ||
            current.mes === expected.source ||
            getCurrentSwipeText(current) === expected.source;
        if (!sourceStillMatches) return;

        if (!current.extra) current.extra = {};
        const displayMatchesMessage = current.extra.display_text === current.mes;
        const missingDisplay = !current.extra.display_text ||
            current.extra.display_text === expected.source ||
            (!expected.isInput && displayMatchesMessage);
        const wrongMessageSource = expected.isInput
            ? current.mes !== expected.translatedText
            : current.mes !== expected.source;
        if (missingDisplay || wrongMessageSource) {
            current.extra.original_mes = expected.source;
            current.extra.display_text = expected.displayText;
            current.mes = expected.isInput ? expected.translatedText : expected.source;
            console.warn(`[CAT] 🔁 번역 표시 상태 재적용 #${msgId} (${delay}ms)`);
            $(`.mes[mesid="${msgId}"]`).attr('data-cat-translated', 'true');
            liveContext.updateMessageBlock(msgId, current);
            scheduleChatSave(`verify ${msgId}`);
            return;
        }

        $(`.mes[mesid="${msgId}"]`).attr('data-cat-translated', 'true');
    }, delay);

    verify(80);
    verify(500);
    setTimeout(() => {
        if (_translationApplyTokens.get(msgId) === token) {
            _translationApplyTokens.delete(msgId);
        }
    }, 1200);
}

function getOutputTargetLanguage() {
    return settings.dialogueBilingual && settings.dialogueBilingual !== 'off'
        ? 'Korean'
        : (settings.targetLang || 'Korean');
}

function getCurrentSwipeText(msg) {
    if (!Array.isArray(msg?.swipes) || msg.swipe_id === undefined) return null;
    const text = msg.swipes[msg.swipe_id];
    return typeof text === 'string' && text.trim() ? text : null;
}

function resolveAssistantSource(msg) {
    const displayText = msg?.extra?.display_text || '';
    const displayNatural = stripLiteralDetails(displayText);
    const targetLang = getOutputTargetLanguage();
    const candidates = [
        { origin: 'swipe', text: getCurrentSwipeText(msg) },
        { origin: 'original_mes', text: msg?.extra?.original_mes },
        { origin: 'msg.mes', text: msg?.mes }
    ].filter(item => typeof item.text === 'string' && item.text.trim());
    const unique = candidates.filter((item, index, list) =>
        list.findIndex(other => other.text === item.text) === index
    );
    const nonDisplay = unique.filter(item =>
        item.text !== displayText && item.text !== displayNatural
    );
    const nonTarget = nonDisplay.find(item =>
        !isClearlyLanguage(analyzeLanguage(item.text), targetLang)
    );
    const selected = nonTarget || nonDisplay[0] || unique.find(item => item.origin === 'msg.mes') || unique[0];
    if (!selected) return { text: '', origin: 'none', analysis: analyzeLanguage('') };
    return { ...selected, analysis: analyzeLanguage(selected.text) };
}

const repairedMessageSnapshots = new WeakMap();
function repairSnapshot(msg) {
    return [msg.mes, msg.extra?.original_mes, msg.extra?.display_text, getCurrentSwipeText(msg), getOutputTargetLanguage()];
}
function repairAssistantMessageState(msg, msgId, source = '') {
    if (!msg || msg.is_user || msg.is_system === true) return { changed: false, source: null };
    if (isTranslatedEditActive(msgId, getLiveChat())) {
        return { changed: false, source: null, deferred: true };
    }
    const snapshot = repairSnapshot(msg);
    const previous = repairedMessageSnapshots.get(msg);
    if (previous && snapshot.every((value, i) => value === previous.snapshot[i])) {
        return { changed: false, source: previous.source };
    }
    const resolved = resolveAssistantSource(msg);
    if (!resolved.text) return { changed: false, source: resolved };

    const targetLang = getOutputTargetLanguage();
    const mesAnalysis = analyzeLanguage(msg.mes || '');
    const sourceIsTarget = isClearlyLanguage(resolved.analysis, targetLang);
    const mesIsTarget = isClearlyLanguage(mesAnalysis, targetLang);
    const displayText = msg.extra?.display_text || '';
    const displayNatural = stripLiteralDetails(displayText);
    const mesMatchesDisplay = !!displayText &&
        (msg.mes === displayText || msg.mes === displayNatural);
    let changed = false;

    if (resolved.text !== msg.mes && (mesMatchesDisplay || (mesIsTarget && !sourceIsTarget))) {
        msg.mes = resolved.text;
        changed = true;
    }

    if (msg.extra) {
        const originalAnalysis = analyzeLanguage(msg.extra.original_mes || '');
        const originalIsTarget = isClearlyLanguage(originalAnalysis, targetLang);
        if ((!msg.extra.original_mes && displayText) ||
            (msg.extra.original_mes !== resolved.text && originalIsTarget && !sourceIsTarget)) {
            msg.extra.original_mes = resolved.text;
            changed = true;
        }
    }

    if (changed) {
        console.warn(
            `[CAT] 🛡️ 메시지 원문 상태 복구 #${msgId} (${source || 'unknown'}): ` +
            `${resolved.origin}, ${resolved.analysis.dominant || 'unknown'} ` +
            `${Math.round(resolved.analysis.confidence * 100)}%`
        );
    }
    repairedMessageSnapshots.set(msg, { snapshot: repairSnapshot(msg), source: resolved });
    return { changed, source: resolved };
}

// 🚨 전역 기준값 영구 보존: extension_settings에 별도 키로 저장
// 프리셋이 적용된 상태에서 새로고침해도 baseline이 오염되지 않음
const BASELINE_VERSION = 4;
const _savedBaseline = extension_settings[EXT_NAME]?._baseline;
const _baselineValid = _savedBaseline && _savedBaseline._v === BASELINE_VERSION;
const _baselineMigratable = _savedBaseline && [2, 3, BASELINE_VERSION].includes(_savedBaseline._v);
const _globalBaseline = _baselineMigratable
    ? {
        commonPrompt: _savedBaseline.commonPrompt ?? _savedBaseline.userPrompt ?? (_savedBaseline._v === 3 ? _savedBaseline.narrationPrompt : '') ?? settings.commonPrompt ?? '',
        narrationPrompt: _savedBaseline.commonPrompt == null && _savedBaseline._v === 3 ? '' : (_savedBaseline.narrationPrompt ?? ''),
        dialoguePrompt: _savedBaseline.dialoguePrompt ?? '',
        temperature: _savedBaseline.temperature ?? 0.3,
        style: _savedBaseline.style ?? 'normal',
        _v: BASELINE_VERSION
    }
    : { commonPrompt: settings.commonPrompt || '', narrationPrompt: settings.narrationPrompt || '', dialoguePrompt: settings.dialoguePrompt || '', temperature: defaultSettings.temperature ?? 0.3, style: defaultSettings.style || 'normal', _v: BASELINE_VERSION };
let _isPresetLoading = false;
if (!_baselineValid) {
    console.warn(_baselineMigratable
        ? '[CAT] 🔄 구버전 기본 설정을 공통·서술·대사 분리 구조로 이전했습니다.'
        : '[CAT] ⚠️ 기본 설정 미존재. "설정 저장 및 적용" 버튼으로 기본 설정을 확정해주세요!');
}
console.log('[CAT] 🏠 전역 baseline 초기화:', { style: _globalBaseline.style, temp: _globalBaseline.temperature, common: _globalBaseline.commonPrompt.substring(0, 30) || '(없음)', narration: _globalBaseline.narrationPrompt.substring(0, 30) || '(없음)', dialogue: _globalBaseline.dialoguePrompt.substring(0, 30) || '(없음)', source: _baselineValid ? '영구저장 복원' : (_baselineMigratable ? '구버전 이전' : '현재 설정') });

// 🚨 프로필/모델 상태에 따른 올바른 테마 판별
function getCurrentTheme() {
    if (settings.profile) {
        const pn = ($('#ct-profile option:selected').text() || '').toLowerCase();
        if (pn.includes('pro') || pn.includes('프로') || pn.includes('호랑이') || pn.includes('tiger')) return 'tiger';
        if (pn.includes('flash') || pn.includes('플래') || pn.includes('플레') || pn.includes('고양이') || pn.includes('cat')) return 'cat';
        return 'cat';
    }
    return getModelTheme(settings.directModel);
}

function restoreDefaultPromptSettings() {
    const currentChar = (SillyTavern?.getContext?.()?.name2) || stContext.name2 || '';
    if (currentChar && settings.charPresetMap?.[currentChar]) {
        delete settings.charPresetMap[currentChar];
    }
    return {
        commonPrompt: _globalBaseline.commonPrompt || '',
        narrationPrompt: _globalBaseline.narrationPrompt || '',
        dialoguePrompt: _globalBaseline.dialoguePrompt || '',
        temperature: _globalBaseline.temperature ?? 0.3,
        style: _globalBaseline.style || 'normal'
    };
}

function saveSettings(updateBaseline = false) {
    const collected = collectSettings();
    
    // 🚨 데이터 손실 방지: 빈 값으로 덮어쓰기 차단
    // 시나리오: textarea가 DOM에 없거나 일시적으로 비어있을 때 빈 값으로 저장되는 거 방지
    if (!collected.dictionary && settings.dictionary) {
        collected.dictionary = settings.dictionary;
        console.log('[CAT] 🛡️ dictionary 보호: 빈 값 덮어쓰기 차단');
    }
    if (!collected.commonPrompt && settings.commonPrompt) {
        collected.commonPrompt = settings.commonPrompt;
        console.log('[CAT] 🛡️ commonPrompt 보호');
    }
    if (!collected.narrationPrompt && settings.narrationPrompt) {
        collected.narrationPrompt = settings.narrationPrompt;
        console.log('[CAT] 🛡️ narrationPrompt 보호');
    }
    if (!collected.dialoguePrompt && settings.dialoguePrompt) {
        collected.dialoguePrompt = settings.dialoguePrompt;
        console.log('[CAT] 🛡️ dialoguePrompt 보호');
    }
    if ((!collected.charPresetMap || Object.keys(collected.charPresetMap).length === 0) && 
        settings.charPresetMap && Object.keys(settings.charPresetMap).length > 0) {
        collected.charPresetMap = settings.charPresetMap;
        console.log('[CAT] 🛡️ charPresetMap 보호: 채팅방별 설정 보존');
    }
    if ((!collected.promptPresets || Object.keys(collected.promptPresets).length === 0) && 
        settings.promptPresets && Object.keys(settings.promptPresets).length > 0) {
        collected.promptPresets = settings.promptPresets;
        console.log('[CAT] 🛡️ promptPresets 보호');
    }
    
    Object.assign(settings, collected);
    // 🚨 baseline 갱신 조건: 수동 저장 + 프리셋 비활성 상태에서만
    if (updateBaseline) {
        const currentChar = (SillyTavern?.getContext?.()?.name2) || stContext.name2 || '';
        const hasCharPreset = !!(currentChar && settings.charPresetMap?.[currentChar]);
        const hasSelectedPreset = !!$('#ct-prompt-preset').val();
        if (hasCharPreset || hasSelectedPreset) {
            // 🚨 프리셋 활성 중 → baseline 보호, 프리셋만 저장
            console.log(`[CAT] 🔒 baseline 보호: 프리셋 활성 상태에서 저장 → baseline 유지`);
            catNotify(`${getThemeEmoji()} 캐릭터 설정 저장됨 (기본 설정은 변경되지 않음)`, "success");
        } else {
            // 🚨 프리셋 없음 → 진짜 전역 기본값 갱신
            _globalBaseline.commonPrompt = settings.commonPrompt || '';
            _globalBaseline.narrationPrompt = settings.narrationPrompt || '';
            _globalBaseline.dialoguePrompt = settings.dialoguePrompt || '';
            _globalBaseline.temperature = settings.temperature ?? 0.3;
            _globalBaseline.style = settings.style || 'normal';
            _globalBaseline._v = BASELINE_VERSION;
            console.log('[CAT] 🏠 baseline 갱신 (수동 저장):', { style: _globalBaseline.style, temp: _globalBaseline.temperature, common: _globalBaseline.commonPrompt.substring(0, 30) || '(없음)', narration: _globalBaseline.narrationPrompt.substring(0, 30) || '(없음)', dialogue: _globalBaseline.dialoguePrompt.substring(0, 30) || '(없음)' });
        }
    }
    // 🚨 baseline을 extension_settings에 영구 저장 (새로고침 후에도 복원)
    extension_settings[EXT_NAME] = { ...settings, _baseline: { ..._globalBaseline } };
    stContext.saveSettingsDebounced();
    applyTheme(getCurrentTheme()); updateCacheStats();
}

// 🚨 beta.9: 진행 중 번역 중단 레지스트리 — 번역 중 버튼 재탭 = 중단
const _activeTranslationAborts = new Map();
const _internalInputEditTokens = new Map();

export function abortMessageTranslation(msgId) {
    const ctrl = _activeTranslationAborts.get(parseInt(msgId, 10));
    if (ctrl && !ctrl.signal.aborted) { ctrl.abort(); return true; }
    return false;
}
// ui.js와의 순환 import 회피용 브릿지
if (typeof window !== 'undefined') window.__catAbortTranslation = abortMessageTranslation;

function applyPendingInternalInput(msgId, chatRef) {
    const pending = window.__catPendingInternalInput;
    const msg = chatRef?.[msgId];
    if (!pending || !msg?.is_user) return false;
    const match = resolvePendingInternalInputMatch(pending, msg, chatRef);
    if (!match.ok) return false;
    // 빈 채팅의 첫 전송 때 ST가 새 채팅 파일을 만들며 chat 배열 참조를 교체한다.
    // 번역문이 정확히 일치하고 대기 중 요청이면 안전하게 새 배열로 연결한다.
    if (match.chatChanged) {
        console.log('[CAT] 🔄 새 채팅 배열 생성 감지 → 대기 중 내부 입력 연결 승계');
        pending.chatRef = chatRef;
    }

    applyInternalInputState(
        msg,
        pending.sourceText,
        pending.translatedText,
        pending.targetLang
    );
    window.__catPendingInternalInput = null;
    $(`.mes[mesid="${msgId}"]`).attr('data-cat-translated', 'true');
    stContext.updateMessageBlock(msgId, msg);
    const sendArea = document.getElementById('send_textarea');
    if (sendArea) {
        const currentDraft = String(sendArea.value || '');
        if (shouldRestoreInternalInputDraft(currentDraft, pending.translatedText)) {
            setTextareaValue(sendArea, pending.nextDraft || '');
        }
    }
    scheduleChatSave(`internal input ${msgId}`);
    console.log(`[CAT] 🌐 내부 입력 연결 완료 #${msgId}: 화면=한국어 / AI=${pending.targetLang}`);
    return true;
}

function reconcilePendingInternalInput() {
    const pending = window.__catPendingInternalInput;
    const chatRef = getLiveChat();
    if (!pending || !Array.isArray(chatRef)) return false;
    const firstCandidate = Math.max(0, chatRef.length - 8);
    for (let msgId = chatRef.length - 1; msgId >= firstCandidate; msgId--) {
        if (!chatRef[msgId]?.is_user) continue;
        if (applyPendingInternalInput(msgId, chatRef)) return true;
    }
    return false;
}
if (typeof window !== 'undefined') window.__catReconcilePendingInternalInput = reconcilePendingInternalInput;

async function handleInternalInputSourceEdit(msgId, capturedText, expectedChatRef) {
    if (getLiveChat() !== expectedChatRef) return;
    const msg = expectedChatRef?.[msgId];
    const previous = getInternalInputState(msg);
    if (!msg?.is_user || !previous) return;

    const fallbackSource = msg.mes !== previous.translatedText ? msg.mes : previous.sourceText;
    const nextSource = String(capturedText ?? fallbackSource ?? '').trim();
    if (!nextSource || isSameSourceForEdit(nextSource, previous.sourceText)) {
        applyInternalInputState(msg, previous.sourceText, previous.translatedText, previous.targetLang);
        stContext.updateMessageBlock(msgId, msg);
        return;
    }

    const active = _internalInputEditTokens.get(msgId);
    if (active?.sourceText === nextSource) return;
    const editToken = `internal-edit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    _internalInputEditTokens.set(msgId, { token: editToken, sourceText: nextSource });

    // ST가 편집 저장 과정에서 msg.mes를 한국어로 덮어쓴 순간부터 AI 컨텍스트가
    // 오염되지 않도록, 새 번역이 올 때까지 직전 전달문을 유지한다.
    applyInternalInputState(msg, nextSource, previous.translatedText, previous.targetLang);
    stContext.updateMessageBlock(msgId, msg);
    catNotify(`${getThemeEmoji()} 한국어 원문 수정 → ${previous.targetLang} 전달문 갱신 중...`, 'info');

    const inputSettings = {
        ...settings,
        dialogueBilingual: 'off',
        literalBilingual: 'off',
        targetLang: previous.targetLang,
        commonPrompt: '',
        narrationPrompt: '',
        dialoguePrompt: resolveInputUserPrompt(settings),
        userPrompt: ''
    };
    const contextMsgs = gatherInternalInputContextMessages(msgId, stContext);

    try {
        const direction = resolveInputTranslationDirection(nextSource, {
            ...inputSettings,
            bidirectional: 'off'
        });
        const result = direction.shouldTranslate
            ? await fetchTranslation(nextSource, inputSettings, stContext, {
                forceLang: previous.targetLang,
                contextMessages: contextMsgs,
                silent: true,
                internalInputFast: true
            })
            : { text: nextSource, lang: previous.targetLang };

        const activeEdit = _internalInputEditTokens.get(msgId);
        const freshMsg = expectedChatRef?.[msgId];
        const freshState = getInternalInputState(freshMsg);
        if (getLiveChat() !== expectedChatRef || activeEdit?.token !== editToken || freshState?.sourceText !== nextSource) return;

        if (!result?.text?.trim()) {
            applyInternalInputState(freshMsg, previous.sourceText, previous.translatedText, previous.targetLang);
            stContext.updateMessageBlock(msgId, freshMsg);
            catNotify(`${getThemeEmoji()} 내부 번역 실패로 수정 전 상태를 복구했어요.`, 'warning');
            return;
        }

        applyInternalInputState(freshMsg, nextSource, result.text, previous.targetLang);
        $(`.mes[mesid="${msgId}"]`).attr('data-cat-translated', 'true');
        stContext.updateMessageBlock(msgId, freshMsg);
        scheduleChatSave(`internal input edit ${msgId}`);
        catNotify(`${getCompletionEmoji()} 한국어 원문과 AI 전달문을 함께 갱신했어요.`, 'success');
    } catch (error) {
        const freshMsg = expectedChatRef?.[msgId];
        if (freshMsg && getLiveChat() === expectedChatRef) {
            applyInternalInputState(freshMsg, previous.sourceText, previous.translatedText, previous.targetLang);
            stContext.updateMessageBlock(msgId, freshMsg);
        }
        console.warn('[CAT] 내부 입력 원문 재번역 실패:', error);
        catNotify(`${getThemeEmoji()} 내부 번역 오류로 수정 전 상태를 복구했어요.`, 'warning');
    } finally {
        if (_internalInputEditTokens.get(msgId)?.token === editToken) {
            _internalInputEditTokens.delete(msgId);
        }
    }
}

async function processMessage(id, isInput = false, abortSignal = null, silent = false, isAutoEvent = false) {
    const msgId = parseInt(id, 10);
    const processChatRef = getLiveChat();
    let msg = processChatRef?.[msgId];
    if (!msg) return;
    if (isInput && getInternalInputState(msg)) {
        if (!isAutoEvent && !silent) {
            catNotify(`${getThemeEmoji()} 이미 내부 번역된 입력입니다. 🐟/🍖로 AI 전달문을 수정할 수 있어요.`, 'info');
        }
        return;
    }
    const processSwipeId = msg.swipe_id;
    const repaired = repairAssistantMessageState(msg, msgId, 'processMessage');
    if (repaired.changed) scheduleChatSave('processMessage repair');
    msg = processChatRef[msgId];
    
    const mesBlock = $(`.mes[mesid="${msgId}"]`);

    // 🚨 스와이프 감지: 이전 번역을 swipe_translations에 보존 후 현재 swipe 데이터로 전환
    if (msg.extra?.original_mes && msg.extra?.cat_swipe_id !== undefined &&
        msg.swipe_id !== undefined && msg.swipe_id !== msg.extra.cat_swipe_id) {
        const prevSwipeId = msg.extra.cat_swipe_id;
        // 이전 swipe의 번역을 보존
        if (msg.extra.display_text) {
            if (!msg.extra.swipe_translations) msg.extra.swipe_translations = {};
            msg.extra.swipe_translations[prevSwipeId] = {
                original_mes: msg.extra.original_mes,
                display_text: msg.extra.display_text
            };
            console.log(`[CAT] 💾 스와이프 #${prevSwipeId} 번역 보존 #${msgId}`);
        }
        
        // 현재 swipe에 저장된 번역이 있으면 복원
        const currentSwipeData = msg.extra.swipe_translations?.[msg.swipe_id];
        const currentSwipeText = getCurrentSwipeText(msg);
        const currentDataMatchesSource = currentSwipeData?.original_mes &&
            (!currentSwipeText ||
                currentSwipeText === currentSwipeData.original_mes ||
                msg.mes === currentSwipeData.original_mes);
        if (currentSwipeData?.original_mes && currentSwipeData?.display_text && currentDataMatchesSource) {
            msg.extra.original_mes = currentSwipeData.original_mes;
            msg.extra.display_text = currentSwipeData.display_text;
            msg.extra.cat_swipe_id = msg.swipe_id;
            console.log(`[CAT] 🔄 스와이프 #${msg.swipe_id} 저장된 번역 복원 #${msgId}`);
            stContext.updateMessageBlock(msgId, msg);
            mesBlock.attr('data-cat-translated', 'true');
        } else {
            if (currentSwipeData && !currentDataMatchesSource) {
                console.warn(`[CAT] 🧹 스와이프 #${msg.swipe_id} 원문 불일치 캐시 무시 #${msgId}`);
                delete msg.extra.swipe_translations[msg.swipe_id];
            }
            // 현재 swipe 첫 방문 → 번역 데이터 초기화 (다시 번역 가능 상태)
            delete msg.extra.original_mes;
            delete msg.extra.display_text;
            delete msg.extra.cat_literal;
            delete msg.extra.cat_prev_display;
            delete msg.extra.cat_swipe_id;
            mesBlock.removeAttr('data-cat-translated');
            stContext.updateMessageBlock(msgId, msg);
            console.log(`[CAT] 🆕 스와이프 #${msg.swipe_id} 첫 방문 → 새 번역 대기`);
        }
    }

    if (!msg.extra?.display_text && mesBlock.attr('data-cat-translated') === 'true') {
        mesBlock.removeAttr('data-cat-translated');
    }
    if (isAutoEvent && mesBlock.attr('data-cat-translated') === 'true') return;
    if (isAutoEvent && msg.extra?.display_text) return;
    // 🚨 숨긴 메시지(Hide) + 이미지/시스템 메시지 자동 번역 스킵
    if (isAutoEvent && (msg.is_hidden || msg.is_system === true || !String(msg.mes || '').trim() || mesBlock.css('display') === 'none' || mesBlock.hasClass('is_hidden'))) return;
    // 번역문이 없는데 translated 마커만 남은 경우 영어 원문을 번역문으로 날조하지 않는다.
    if (msg.extra?.original_mes && !msg.extra?.display_text && mesBlock.attr('data-cat-translated') === 'true') {
        mesBlock.removeAttr('data-cat-translated');
        console.warn(`[CAT] 🧹 불완전 번역 상태 정리 #${msgId}: display_text 없음`);
    }
    // 🚨 Legacy 감지: 구버전에서 msg.mes가 번역문으로 덮어쓰여진 경우 자동 복원
    if (msg.extra?.original_mes && msg.extra?.display_text && msg.mes === msg.extra.display_text && msg.mes !== msg.extra.original_mes) {
        msg.mes = msg.extra.original_mes;
        console.log(`[CAT] 🔧 Legacy 메시지 #${msgId} 자동 복원: msg.mes → 원문`);
    }

    const startGlow = () => {
        mesBlock.find('.cat-mes-trans-btn .cat-emoji-icon').addClass('cat-glow-anim').attr('data-cat-glow-start', Date.now());
    };
    const stopGlow = () => mesBlock.find('.cat-mes-trans-btn .cat-emoji-icon').removeClass('cat-glow-anim').removeAttr('data-cat-glow-start');

    // 🚨 v1.1.8 (N): 중복 실행 게이트를 DOM 글로우가 아닌 '실제 진행 레지스트리'로 판정.
    // 기존엔 글로우 애니메이션 존재 여부가 게이트였는데, 180초 글로우 타임아웃이
    // UI만 끄고 실제 번역은 계속 돌아서 — 토큰 150개급 초대형 메시지가 180초를
    // 정상 초과하면 게이트가 열리고, 다음 트리거가 거의 다 된 번역을 중단시키는
    // "중단됨 무한 루프"가 실측 제보됨. 이제:
    //  · 진행 중 + 자동/조용/벌크 재트리거 → 죽이지 않고 조용히 스킵
    //  · 진행 중 + 수동 탭 → 기존 설계대로 중단 후 재시작 (사용자에게 고지)
    //  · 글로우 타임아웃은 순수 UI 청소로 강등 (게이트 역할 제거)
    const inflightCtrl = _activeTranslationAborts.get(msgId);
    const hasInflight = !!(inflightCtrl && !inflightCtrl.signal.aborted);
    if (hasInflight && (isAutoEvent || silent || abortSignal)) {
        console.log(`[CAT] ⏳ 진행 중 번역 유지 — 자동/조용/벌크 재트리거 스킵 #${msgId}`);
        return;
    }
    if (hasInflight && !silent) {
        catNotify(`${getThemeEmoji()} 이전 번역을 중단하고 새로 시작해요. 긴 메시지는 수 분 걸릴 수 있어요.`, "info");
    }

    // 🚨 글로우 stuck 자동 감지 및 복구 (v1.1.8부터 순수 UI 청소 — 게이트 아님)
    const stuckGlow = mesBlock.find('.cat-mes-trans-btn .cat-emoji-icon.cat-glow-anim');
    if (stuckGlow.length > 0) {
        const startTime = parseInt(stuckGlow.attr('data-cat-glow-start') || '0');
        const elapsed = Date.now() - startTime;
        if (startTime > 0 && elapsed > 180000) {
            console.warn(`[CAT] 🔧 글로우 stuck 감지 (${Math.round(elapsed/1000)}s) → 강제 해제 #${msgId}`);
            stopGlow();
        }
    }
    startGlow();
    // 🚨 글로우 안전장치: 60초 후 자동 해제 (에러로 stuck 방지)
    const glowTimeout = setTimeout(() => { stopGlow(); console.warn(`[CAT] ⚠️ 글로우 타임아웃 #${msgId}`); }, 180000); // 🚨 beta.3: 장문+재시도는 60초를 정상 초과 → 조기 소등이 유저 재탭·중복 실행 유발
    let historyShown = false;
    // 🚨 beta.9: 외부 signal(벌크 등) 없으면 자체 중단 컨트롤러 생성 — 수동/자동 모두 버튼 탭으로 중단 가능
    // (진행 레지스트리 게이트 통과 이후 시점에 등록해 레지스트리 누수 방지)
    let _ownAbortCtrl = null;
    if (!abortSignal) {
        // 🚨 beta.3: 같은 메시지에 진행 중인 번역이 있으면 먼저 중단 — 글로우 소등 후
        // 재탭 시 기존 번역이 도는 채로 새 번역이 겹쳐 돌던 동시 실행 차단
        const staleCtrl = _activeTranslationAborts.get(msgId);
        if (staleCtrl && !staleCtrl.signal.aborted) {
            console.warn(`[CAT] ⛔ 기존 진행 중 번역 중단 후 새로 시작 #${msgId}`);
            staleCtrl.abort();
        }
        _ownAbortCtrl = new AbortController();
        abortSignal = _ownAbortCtrl.signal;
        _activeTranslationAborts.set(msgId, _ownAbortCtrl);
    }

    try {
        const editArea = mesBlock.find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible').first();
        if (editArea.length > 0) { await handleEditAreaTranslation(editArea, msgId, abortSignal, isInput); return; }

        // 🚨 원본 결정: original_mes + display_text + 스와이프 일치 여부로 판정
        let textToTranslate;
        let sourceOrigin = 'msg.mes';
        const hasTranslation = msg.extra?.original_mes && msg.extra?.display_text &&
            (msg.extra?.cat_swipe_id === undefined || msg.extra.cat_swipe_id === msg.swipe_id);
        
        if (hasTranslation) {
            textToTranslate = msg.extra.original_mes;
            sourceOrigin = 'original_mes';
        } else if (!isInput) {
            const sourceInfo = resolveAssistantSource(msg);
            textToTranslate = sourceInfo.text || msg.mes;
            sourceOrigin = sourceInfo.origin;
        } else {
            textToTranslate = msg.mes;
        }
        const sourceAnalysis = analyzeLanguage(textToTranslate);
        console.log(
            `[CAT] 🧭 번역 원문 #${msgId}: ${sourceOrigin}, ${sourceAnalysis.dominant || 'unknown'} ` +
            `${Math.round(sourceAnalysis.confidence * 100)}%`
        );

        if (isInput && !hasTranslation) {
            const inputDirection = resolveInputTranslationDirection(textToTranslate, settings);
            if (!inputDirection.shouldTranslate) {
                console.log(
                    `[CAT] ⏭️ 자동 입력 번역 생략 #${msgId}: 이미 ${inputDirection.targetLang} ` +
                    `(${Math.round(inputDirection.analysis.confidence * 100)}%)`
                );
                return;
            }
        }

        // 🚨 직역 병기 details 블록은 재번역 프롬프트 오염 방지 위해 제거
        const existingTranslation = hasTranslation ? stripLiteralDetails(msg.extra.display_text) : null;
        const isRetranslation = hasTranslation;
        const processStateSnapshot = {
            mes: msg.mes,
            original: msg.extra?.original_mes,
            display: msg.extra?.display_text,
            swipeText: getCurrentSwipeText(msg)
        };

        const notifyCacheMiss = !silent && !isRetranslation
            ? () => {
                const prefix = isAutoEvent ? '자동 번역' : '번역';
                catNotify(`${getThemeEmoji()} ${prefix} 진행 중...`, "success");
            }
            : null;

        // 🚨 beta.13: 팝업은 유저 버튼 탭에서만 — 벌크(외부 signal)/자동(isAutoEvent)/silent 경로는 기존대로 직행
        if (isRetranslation && !silent && !isAutoEvent && _ownAbortCtrl) {
            const anchorEl = mesBlock.find('.cat-mes-trans-btn');
            const detected = detectDir(textToTranslate);
            const modelKey = getCacheModelKey(settings, SillyTavern.getContext());
            // 🚨 beta.9: 직전 번역이 있고 현재 표시본과 다르면 팝업에 복귀 항목 제공
            const prevDisplayForPopup = (msg.extra?.cat_prev_display && msg.extra.cat_prev_display !== msg.extra?.display_text)
                ? msg.extra.cat_prev_display : null;
            const shown = await showHistoryPopup(textToTranslate, detected.targetLang, anchorEl, async (selectedText, isNew) => {
                if (isNew) {
                    if (getLiveChat() !== processChatRef) {
                        console.warn(`[CAT] ⏭️ 채팅 전환으로 재번역 요청 취소 #${msgId}`);
                        return;
                    }
                    startGlow();
                    // 🚨 beta.9: 팝업 경유 번역도 중단 가능하게 별도 컨트롤러 등록
                    const popupCtrl = new AbortController();
                    _activeTranslationAborts.set(msgId, popupCtrl);
                    try {
                        await doTranslateMessage(msgId, msg, textToTranslate, isInput, existingTranslation, popupCtrl.signal, true, false, processChatRef);
                    } finally {
                        stopGlow();
                        if (_activeTranslationAborts.get(msgId) === popupCtrl) _activeTranslationAborts.delete(msgId);
                    }
                } else if (selectedText) {
                    if (getLiveChat() !== processChatRef) {
                        console.warn(`[CAT] ⏭️ 채팅 전환으로 번역 히스토리 적용 취소 #${msgId}`);
                        return;
                    }
                    const freshMsg = processChatRef[msgId];
                    if (!freshMsg || freshMsg.swipe_id !== processSwipeId) return;
                    const stateUnchanged =
                        freshMsg.mes === processStateSnapshot.mes &&
                        freshMsg.extra?.original_mes === processStateSnapshot.original &&
                        freshMsg.extra?.display_text === processStateSnapshot.display &&
                        getCurrentSwipeText(freshMsg) === processStateSnapshot.swipeText;
                    if (!stateUnchanged) {
                        console.warn(`[CAT] ⏭️ 메시지 변경으로 번역 히스토리 적용 취소 #${msgId}`);
                        return;
                    }
                    if (!freshMsg.extra) freshMsg.extra = {};
                    freshMsg.extra.original_mes = textToTranslate;
                    // 🚨 beta.9: 히스토리/직전 번역 적용 시에도 현재 번역 백업 (토글 왕복)
                    if (freshMsg.extra.display_text && freshMsg.extra.display_text !== selectedText) {
                        freshMsg.extra.cat_prev_display = freshMsg.extra.display_text;
                    }
                    freshMsg.extra.display_text = selectedText;
                    if (isInput) freshMsg.mes = selectedText;
                    else freshMsg.mes = textToTranslate;
                    if (freshMsg.swipe_id !== undefined) {
                        freshMsg.extra.cat_swipe_id = freshMsg.swipe_id;
                        if (!freshMsg.extra.swipe_translations) freshMsg.extra.swipe_translations = {};
                        freshMsg.extra.swipe_translations[freshMsg.swipe_id] = {
                            original_mes: textToTranslate,
                            display_text: selectedText
                        };
                    }
                    $(`.mes[mesid="${msgId}"]`).attr('data-cat-translated', 'true');
                    stContext.updateMessageBlock(msgId, freshMsg);
                    scheduleChatSave(`history ${msgId}`);
                    scheduleTranslationVerification(msgId, {
                        source: textToTranslate,
                        displayText: selectedText,
                        translatedText: selectedText,
                        swipeId: freshMsg.swipe_id,
                        isInput,
                        chatRef: processChatRef
                    });
                }
            }, modelKey, prevDisplayForPopup);
            if (shown) { historyShown = true; return; }
        }
        await doTranslateMessage(msgId, msg, textToTranslate, isInput, existingTranslation, abortSignal, silent, false, processChatRef, notifyCacheMiss);
    } finally {
        clearTimeout(glowTimeout); if (!historyShown) stopGlow();
        // 🚨 beta.9: 중단 레지스트리 정리 (자체 생성분만)
        if (_ownAbortCtrl && _activeTranslationAborts.get(msgId) === _ownAbortCtrl) _activeTranslationAborts.delete(msgId);
    }
}

async function doTranslateMessage(msgId, msg, textToTranslate, isInput, prevTranslation, abortSignal, silent = false, forceFresh = false, requestChatRef = getLiveChat(), onCacheMiss = null) {
    if (getLiveChat() !== requestChatRef) return;
    const requestMsg = requestChatRef?.[msgId] || msg;
    const requestedSwipeId = requestMsg.swipe_id;
    let translationSettings = settings;
    let forceLang;

    if (isInput) {
        const inputDirection = resolveInputTranslationDirection(textToTranslate, settings);
        if (!inputDirection.shouldTranslate) {
            console.log(
                `[CAT] ⏭️ 입력 번역 생략 #${msgId}: 이미 ${inputDirection.targetLang}` +
                ` (${Math.round(inputDirection.analysis.confidence * 100)}%)`
            );
            return;
        }
        forceLang = inputDirection.targetLang;
        translationSettings = {
            ...settings,
            dialogueBilingual: 'off',
            literalBilingual: 'off',
            targetLang: inputDirection.targetLang,
            // 🚨 v1.1.4-beta.3: 인풋 번역은 전용 프롬프트 사용 (비어있으면 공용 폴백)
            commonPrompt: '',
            narrationPrompt: '',
            dialoguePrompt: resolveInputUserPrompt(settings),
            userPrompt: ''
        };
    } else {
        const detected = detectLanguageDirection(textToTranslate, settings);
        forceLang = detected.targetLang;
    }

    const contextRange = normalizeContextRange(settings.contextRange);
    const contextMsgs = gatherContextMessages(msgId, stContext, contextRange);
    const requestToken = `request:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    _translationApplyTokens.set(msgId, requestToken);

    const result = await fetchTranslation(textToTranslate, translationSettings, stContext, {
        forceLang,
        prevTranslation: isInput ? (requestMsg.extra?.original_mes ? requestMsg.mes : null) : prevTranslation,
        contextMessages: contextMsgs,
        abortSignal,
        silent,
        forceFresh,
        onCacheMiss
    });

    if (_translationApplyTokens.get(msgId) !== requestToken) {
        console.warn(`[CAT] ⏭️ 취소되거나 교체된 번역 결과 폐기 #${msgId}`);
        return;
    }

    if (result && result.text && result.text.trim() && result.text !== textToTranslate) {
        if (getLiveChat() !== requestChatRef) {
            console.warn(`[CAT] ⏭️ 번역 중 채팅 변경 → 낡은 결과 폐기 #${msgId}`);
            _translationApplyTokens.delete(msgId);
            return;
        }
        const freshMsg = requestChatRef[msgId];
        if (!freshMsg) {
            _translationApplyTokens.delete(msgId);
            return;
        }
        if (freshMsg.swipe_id !== requestedSwipeId) {
            console.warn(`[CAT] ⏭️ 번역 중 스와이프 변경 → 낡은 결과 폐기 #${msgId}`);
            if (!silent) catNotify(`${getThemeEmoji()} 번역 중 메시지가 바뀌어 이전 결과를 적용하지 않았어요.`, "warning");
            _translationApplyTokens.delete(msgId);
            return;
        }

        const freshSource = isInput
            ? (freshMsg.extra?.original_mes || freshMsg.mes)
            : resolveAssistantSource(freshMsg).text;
        const sourceStillMatches = freshSource === textToTranslate ||
            freshMsg.extra?.original_mes === textToTranslate ||
            freshMsg.mes === textToTranslate;
        if (!sourceStillMatches) {
            console.warn(`[CAT] ⏭️ 번역 중 원문 변경 → 낡은 결과 폐기 #${msgId}`);
            if (!silent) catNotify(`${getThemeEmoji()} 번역 중 원문이 바뀌어 이전 결과를 적용하지 않았어요.`, "warning");
            _translationApplyTokens.delete(msgId);
            return;
        }

        if (!freshMsg.extra) freshMsg.extra = {};
        freshMsg.extra.original_mes = textToTranslate;
        // 🚨 beta.9: 직전 번역 백업 — 재번역으로 덮어쓰기 전 현재 번역문 보존 (↩️ 직전 번역 복귀용)
        if (freshMsg.extra.display_text && freshMsg.extra.display_text !== result.text) {
            freshMsg.extra.cat_prev_display = freshMsg.extra.display_text;
        }
        // 🚨 직역 병기: 직역 파트가 있으면 자연번역 아래 접이식 details 블록 합성 (인풋 제외)
        let displayWithLiteral = result.text;
        if (result.literal && !isInput) {
            freshMsg.extra.cat_literal = result.literal;
            // 🚨 원문도 접이식 안에 포함 (이미 보유한 original_mes 재활용 — 토큰 0)
            displayWithLiteral = result.text + '\n\n' + buildLiteralDetailsHtml(result.literal, textToTranslate);
            console.log('[CAT] 🔍 직역 병기 합성 완료 (원문 포함)');
        } else {
            delete freshMsg.extra.cat_literal;
        }
        freshMsg.extra.display_text = displayWithLiteral;
        if (freshMsg.swipe_id !== undefined) {
            freshMsg.extra.cat_swipe_id = freshMsg.swipe_id;
            // 🚨 스와이프별 번역 보존 — 다른 스와이프로 전환했다 돌아와도 유지됨
            if (!freshMsg.extra.swipe_translations) freshMsg.extra.swipe_translations = {};
            freshMsg.extra.swipe_translations[freshMsg.swipe_id] = {
                original_mes: textToTranslate,
                display_text: displayWithLiteral
            };
        }
        // 🚨 입력 메시지: msg.mes = 번역문(영어) → AI 컨텍스트에 영어 전달
        // 🚨 출력 메시지: msg.mes = 원문 유지 → 컨텍스트 오염 방지
        if (isInput) {
            freshMsg.mes = result.text;
        } else {
            freshMsg.mes = textToTranslate;
        }
        
        $(`.mes[mesid="${msgId}"]`).attr('data-cat-translated', 'true');
        // 🚨 편집 버튼 표시 (번역 완료 → 🐟/🍖 활성화)
        $(`.mes[mesid="${msgId}"]`).find('.cat-mes-edit-btn').css({ opacity: 0.8, 'pointer-events': 'auto' });

        stContext.updateMessageBlock(msgId, freshMsg);
        scheduleChatSave(`translation ${msgId}`);
        scheduleTranslationVerification(msgId, {
            source: textToTranslate,
            displayText: displayWithLiteral,
            translatedText: result.text,
            swipeId: requestedSwipeId,
            isInput,
            chatRef: requestChatRef
        });
        if (!silent) {
            const preview = result.text.substring(0, 25) + (result.text.length > 25 ? '...' : '');
            catNotify(`${getCompletionEmoji()} 번역 완료! '${preview}'`, "success");
        }

        // 🚨 Scene Board 확장 호환: msg.extra.sceneBoard.text도 같이 번역
        if (freshMsg.extra?.sceneBoard?.text && freshMsg.extra.sceneBoard.text.trim().length > 10) {
            try {
                const sceneBoard = freshMsg.extra.sceneBoard;
                // 원본 결정: 백업이 있으면 그것, 없으면 현재 text
                const sbOriginalText = sceneBoard.cat_original_text || sceneBoard.text;
                console.log(`[CAT] 🎬 Scene Board 번역 시작 (${sbOriginalText.length}자)`);
                const sbResult = await fetchTranslation(sbOriginalText, translationSettings, stContext, {
                    forceLang, 
                    silent: true 
                });
                if (sbResult && sbResult.text && sbResult.text.trim() && sbResult.text !== sbOriginalText) {
                    if (getLiveChat() !== requestChatRef) {
                        console.warn(`[CAT] ⏭️ Scene Board 번역 중 채팅 변경 → 결과 폐기 #${msgId}`);
                        return;
                    }
                    const latestMsg = requestChatRef[msgId];
                    const latestSceneBoard = latestMsg?.extra?.sceneBoard;
                    const latestSceneBoardSource = latestSceneBoard?.cat_original_text || latestSceneBoard?.text;
                    if (!latestMsg ||
                        latestMsg.swipe_id !== requestedSwipeId ||
                        latestMsg.extra?.display_text !== displayWithLiteral ||
                        latestSceneBoardSource !== sbOriginalText) {
                        console.warn(`[CAT] ⏭️ Scene Board 원문 변경 → 낡은 결과 폐기 #${msgId}`);
                        return;
                    }
                    // 첫 번역이면 백업 생성
                    if (!latestSceneBoard.cat_original_text) {
                        latestSceneBoard.cat_original_text = sbOriginalText;
                    }
                    latestSceneBoard.text = sbResult.text;
                    
                    // 🚨 DOM 직접 업데이트: Scene Board 확장은 자체 DOM 요소 사용
                    // 셀렉터: pre.sb-board-text (Scene Board 확장이 사용하는 요소)
                    const mesEl = $(`.mes[mesid="${msgId}"]`);
                    const sbDomCandidates = [
                        'pre.sb-board-text',
                        '.sb-board-text',
                        '[class*="sceneBoard"] pre',
                        '[class*="scene-board"] pre',
                        '[class*="sb-board"]'
                    ];
                    let sbElement = null;
                    for (const sel of sbDomCandidates) {
                        const el = mesEl.find(sel).first();
                        if (el.length > 0) { sbElement = el; break; }
                    }
                    if (sbElement && sbElement.length > 0) {
                        // 원본 백업 (없으면)
                        if (!sbElement.attr('data-cat-original')) {
                            sbElement.attr('data-cat-original', sbElement.text());
                        }
                        sbElement.text(sbResult.text);
                        console.log(`[CAT] 🎬 Scene Board DOM 업데이트 완료`);
                    } else {
                        console.warn(`[CAT] 🎬 Scene Board DOM 요소 못 찾음 (셀렉터 확인 필요)`);
                    }
                    
                    console.log(`[CAT] 🎬 Scene Board 번역 완료`);
                    scheduleChatSave(`scene board ${msgId}`);
                    if (!silent) catNotify(`${getThemeEmoji()} Scene Board 같이 번역됨`, "info");
                }
            } catch (e) {
                console.warn(`[CAT] Scene Board 번역 실패:`, e);
            }
        }
    } else if (_translationApplyTokens.get(msgId) === requestToken) {
        _translationApplyTokens.delete(msgId);
    }
}

async function handleEditAreaTranslation(editArea, msgId, abortSignal, isInput = false) {
    const editChatRef = getLiveChat();
    const initialTextareaText = editArea.val().trim();
    let currentText = initialTextareaText;
    if (!currentText) return;
    
    // 🚨 DOM에서 긁혀온 오염물 제거 (hidden comment + 코드박스 잔해)
    currentText = currentText.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!currentText) return;
    
    const msg = editChatRef?.[msgId];
    const requestedSwipeId = msg?.swipe_id;
    
    // 🚨 직전 아웃풋 딸려오기 차단: msg 기준으로 비정상 길이 감지
    if (msg) {
        const knownText = msg.extra?.display_text || msg.extra?.original_mes || msg.mes;
        if (knownText && currentText.length > knownText.length * 1.5) {
            const knownPrefix = knownText.substring(0, Math.min(50, knownText.length));
            if (currentText.startsWith(knownPrefix)) {
                currentText = knownText;
            }
        }
    }
    
    // 🚨 textarea 오염 방지: 이전 콘텐츠가 현재 메시지에 섞여 들어온 경우
    if (msg && msg.mes && currentText.includes(msg.mes) && currentText !== msg.mes) {
        currentText = msg.mes;
    }
    
    // 🚨 핵심: 재번역 vs 새 번역 판별
    let sourceText = currentText;
    let isReTranslation = false;
    let replacesExistingTranslation = false;
    
    if (msg?.extra?.original_mes) {
        if (currentText === msg.extra.display_text || 
            currentText === msg.extra.original_mes) {
            // 수정 안 함 → original_mes에서 재번역
            sourceText = msg.extra.original_mes;
            isReTranslation = true;
        } else {
            // API 성공 전에는 기존 번역 상태를 지우지 않는다.
            replacesExistingTranslation = true;
        }
    }
    
    const prevTrans = isReTranslation ? (msg.extra?.display_text || null) : null;
    catNotify(isReTranslation ? `${getThemeEmoji()} 다른 표현으로 재번역 중...` : `${getThemeEmoji()} 스마트 번역 중...`, "success");
    
    const contextRange = normalizeContextRange(settings.contextRange);
    const contextMsgs = gatherContextMessages(msgId, stContext, contextRange);
    const direction = isInput
        ? resolveInputTranslationDirection(sourceText, settings)
        : { ...detectLanguageDirection(sourceText, settings), shouldTranslate: true };
    if (isInput && !direction.shouldTranslate) {
        catNotify(`${getThemeEmoji()} 이미 AI에게 보낼 언어(${direction.targetLang})예요.`, "info");
        return;
    }
    const editSettings = {
        ...settings,
        dialogueBilingual: 'off',
        literalBilingual: 'off',
        targetLang: direction.targetLang,
        // 인풋은 실제 발화문이므로 인풋 전용 지시를 대사 범위에만 적용한다.
        commonPrompt: isInput ? '' : settings.commonPrompt,
        narrationPrompt: isInput ? '' : settings.narrationPrompt,
        dialoguePrompt: isInput ? resolveInputUserPrompt(settings) : settings.dialoguePrompt,
        userPrompt: ''
    };
    const editRequestToken = `edit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    _translationApplyTokens.set(msgId, editRequestToken);
    const result = await fetchTranslation(sourceText, editSettings, stContext, {
        forceLang: direction.targetLang,
        prevTranslation: prevTrans,
        contextMessages: contextMsgs,
        abortSignal
    });

    if (_translationApplyTokens.get(msgId) !== editRequestToken) {
        console.warn(`[CAT] ⏭️ 취소되거나 교체된 편집 번역 결과 폐기 #${msgId}`);
        return;
    }
    
    if (result && result.text !== currentText) {
        if (getLiveChat() !== editChatRef) {
            console.warn(`[CAT] ⏭️ 편집 번역 중 채팅 변경 → 낡은 결과 폐기 #${msgId}`);
            _translationApplyTokens.delete(msgId);
            return;
        }
        const freshMsg = editChatRef[msgId];
        const latestTextareaText = editArea.val().trim();
        if (!freshMsg || freshMsg.swipe_id !== requestedSwipeId || latestTextareaText !== initialTextareaText) {
            console.warn(`[CAT] ⏭️ 편집 번역 중 원문 변경 → 낡은 결과 폐기 #${msgId}`);
            catNotify(`${getThemeEmoji()} 편집 내용이 바뀌어서 이전 번역 결과를 적용하지 않았어요.`, "warning");
            _translationApplyTokens.delete(msgId);
            return;
        }
        // editArea jQuery 데이터 저장 (세션 내)
        editArea.data('cat-original-text', sourceText);
        editArea.data('cat-last-translated', result.text);
        editArea.data('cat-last-target-lang', result.lang);
        
        if (!freshMsg.extra) freshMsg.extra = {};
        if (replacesExistingTranslation) {
            delete freshMsg.extra.cat_literal;
            if (freshMsg.extra.swipe_translations && freshMsg.swipe_id !== undefined) {
                delete freshMsg.extra.swipe_translations[freshMsg.swipe_id];
            }
        }
        freshMsg.extra.original_mes = sourceText;
        freshMsg.extra.display_text = result.text;
        if (freshMsg.swipe_id !== undefined) {
            freshMsg.extra.cat_swipe_id = freshMsg.swipe_id;
            if (!freshMsg.extra.swipe_translations) freshMsg.extra.swipe_translations = {};
            freshMsg.extra.swipe_translations[freshMsg.swipe_id] = {
                original_mes: sourceText,
                display_text: result.text
            };
        }
        
        setTextareaValue(editArea[0], result.text);
        scheduleChatSave(`edit translation ${msgId}`);
        _translationApplyTokens.delete(msgId);
        catNotify(isReTranslation ? `${getCompletionEmoji()} 재번역 덮어쓰기 완료!` : `${getCompletionEmoji()} 번역 덮어쓰기 완료!`, "success");
    } else {
        _translationApplyTokens.delete(msgId);
    }
}

function revertMessage(id) {
    const msgId = parseInt(id, 10); const msg = getLiveChat()?.[msgId]; if (!msg) return;
    _translationApplyTokens.delete(msgId);
    const editArea = $(`.mes[mesid="${msgId}"]`).find('textarea.edit_textarea:visible, textarea.mes_edit_textarea:visible, textarea:visible').first();
    if (editArea.length > 0) { const originalText = editArea.data('cat-original-text'); if (originalText) { setTextareaValue(editArea[0], originalText); editArea.removeData('cat-original-text').removeData('cat-last-translated').removeData('cat-last-target-lang'); catNotify(`${getThemeEmoji()} 원본 텍스트로 복구 완료!`, "success"); } else { catNotify("⚠️ 복구할 원본이 없습니다.", "warning"); } return; }
    if (clearInternalInputState(msg)) {
        $(`.mes[mesid="${msgId}"]`).removeAttr('data-cat-translated');
        stContext.updateMessageBlock(msgId, msg);
        scheduleChatSave(`internal input revert ${msgId}`);
        catNotify(`${getThemeEmoji()} 내부 번역을 해제하고 한국어 원문으로 복구했어요.`, 'success');
        return;
    }
    if (msg.extra?.display_text) delete msg.extra.display_text;
    if (msg.extra?.cat_literal) delete msg.extra.cat_literal;
            delete msg.extra.cat_prev_display;
    if (msg.extra?.original_mes) {
        // 🚨 입력 메시지는 msg.mes가 번역문이므로 원문 복원 필요
        // 출력 메시지는 msg.mes가 이미 원문이므로 덮어써도 동일
        msg.mes = msg.extra.original_mes;
        delete msg.extra.original_mes;
    }
    if (msg.extra?.swipe_translations && msg.swipe_id !== undefined) {
        delete msg.extra.swipe_translations[msg.swipe_id];
    }
    if (msg.extra?.cat_swipe_id !== undefined) delete msg.extra.cat_swipe_id;
    
    // 🚨 Scene Board 확장 호환: sceneBoard.text도 복원
    if (msg.extra?.sceneBoard?.cat_original_text) {
        msg.extra.sceneBoard.text = msg.extra.sceneBoard.cat_original_text;
        delete msg.extra.sceneBoard.cat_original_text;
        console.log(`[CAT] 🎬 Scene Board 원본 복원`);
    }
    
    // 🚨 Scene Board DOM 복원
    const mesElForRevert = $(`.mes[mesid="${msgId}"]`);
    const sbRevertCandidates = [
        'pre.sb-board-text',
        '.sb-board-text',
        '[class*="sceneBoard"] pre',
        '[class*="scene-board"] pre',
        '[class*="sb-board"]'
    ];
    for (const sel of sbRevertCandidates) {
        const sbEl = mesElForRevert.find(sel).first();
        if (sbEl.length > 0 && sbEl.attr('data-cat-original')) {
            sbEl.text(sbEl.attr('data-cat-original'));
            sbEl.removeAttr('data-cat-original');
            console.log(`[CAT] 🎬 Scene Board DOM 복원 (${sel})`);
            break;
        }
    }
    
    $(`.mes[mesid="${msgId}"]`).removeAttr('data-cat-translated');
    
    stContext.updateMessageBlock(msgId, msg);
    scheduleChatSave(`revert ${msgId}`);
    catNotify(`${getThemeEmoji()} 원문 복구 완료!`, "success");
}
function detectDir(text) { return detectLanguageDirection(text, settings); }

jQuery(async () => {
    // 🚨 v1.1.4 핫픽스: 베타에서 물려받은 공존 가드 제거.
    // 가드는 "정식판(cat-translator)이 켜져 있으면 양보"하는 베타 전용 장치인데,
    // 정식판 자신의 manifest.name이 cat-translator라서 자기 자신을 감지해
    // 로드를 중단하는 자기참조 버그가 발생했음. 양보 책임은 베타 쪽 가드가 담당한다.
    try { await initCache(); console.log(`[CAT] 캐시 준비: ${getCacheStorageMode() === 'memory' ? '현재 탭 메모리 (새로고침 시 초기화)' : '영구 저장'}`); } catch (e) { console.warn('[CAT] 캐시 초기화 실패:', e); }
    const settingsPanelReady = setupSettingsPanel(settings, stContext, saveSettings, restoreDefaultPromptSettings);
    if (!settingsPanelReady) return;
    setupDragDictionary(settings, saveSettings, getLiveChat); setupMutationObserver(processMessage, revertMessage, settings, stContext);
    // 🚨 첫 마이그레이션 / baseline 리셋 안내
    if (!_baselineValid) {
        setTimeout(() => catNotify(`${getThemeEmoji()} 기본 설정을 확인 후 "설정 저장 및 적용" 버튼을 눌러주세요!`, "warning"), 2000);
    }
    // 🚨 자동 번역: 이미지/시스템/숨김 메시지 스킵 (데이터 기반)
    const scheduleAutoOutput = createAutoTranslationScheduler({
        getChat: getLiveChat,
        getMode: () => settings.autoMode,
        process: processMessage,
        onError: error => {
            console.warn('[CAT] 자동 번역 처리 오류:', error?.name || 'Error');
            catNotify('⚠️ [자동 번역 처리 실패] 메시지에 번역을 적용하지 못했어요. 수동 번역으로 다시 확인해 주세요.', 'warning');
        }
    });
    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, scheduleAutoOutput);
    stContext.eventSource.on(stContext.event_types.USER_MESSAGE_RENDERED, async (d) => {
        const msgId = resolveMessageEventId(d);
        if (msgId === null) return;
        const renderedChatRef = getLiveChat();
        if (applyPendingInternalInput(parseInt(msgId, 10), renderedChatRef)) return;
        if (reconcilePendingInternalInput()) return;
        // 내부 번역 모드에서는 전송 전 인터셉터가 입력 번역을 전담한다.
        // 렌더 후 자동 입력 번역까지 타면 이중 호출과 표시 역전이 생긴다.
        if ((settings.internalInputTranslation || 'off') === 'on') return;
        if (settings.autoMode === 'none' || settings.autoMode === 'output') return;
        if (getLiveChat() !== renderedChatRef) return;
        try { await processMessage(msgId, true, null, false, true); }
        catch (error) {
            console.warn('[CAT] 자동 입력 번역 처리 오류:', error?.name || 'Error');
            catNotify('⚠️ [자동 입력 번역 처리 실패] 원문을 확인하고 수동 번역을 다시 실행해 주세요.', 'warning');
        }
    });
    
    // 🚨 메시지 편집 직접 감지 (옵저버 백업) — afterEditMode 'auto'/'notify' 안전 트리거
    stContext.eventSource.on(stContext.event_types.MESSAGE_EDITED, (msgId) => {
        console.log(`[CAT] 🔔 MESSAGE_EDITED 이벤트 수신 #${msgId}`);
        $(`.mes[mesid="${parseInt(typeof msgId === 'object' ? msgId.messageId : msgId, 10)}"]`).data('cat-internal-save-requested', true);
        if (isTranslatedEditActive(msgId, getLiveChat())) {
            markTranslatedEditSave(msgId, null, getLiveChat());
            console.log(`[CAT] 🐟 번역문 편집 세션 보호 → 원문 수정 처리 보류 #${msgId}`);
            return;
        }
        handleEditSaved(msgId);
    });
    
    // 🚨 textarea 값 실시간 추적 (글로벌 Map으로 저장 - DOM 재생성에도 보존)
    window._catCapturedText = window._catCapturedText || new Map();
    
    $(document).on('input keyup change', 'textarea.edit_textarea, textarea.mes_edit_textarea, .mes textarea', function() {
        const mesBlock = $(this).closest('.mes');
        const msgId = mesBlock.attr('mesid');
        const val = $(this).val();
        if (msgId && val && val.length > 0) {
            window._catCapturedText.set(msgId, val);
            console.log(`[CAT] 📝 textarea 변경 #${msgId}: ${val.substring(0, 40)}...`);
        }
    });
    
    // 🚨 ST 저장 클릭 직전 textarea 값 캡처
    $(document).on('mousedown touchstart', '.mes_edit_done, .mes_edit_save, .edit_mes_save, [class*="mes_edit_done"]', function () {
        const mesBlock = $(this).closest('.mes');
        const msgId = mesBlock.attr('mesid');
        const editChatRef = getLiveChat();
        // 가장 최근에 보이는 textarea 즉시 캡처
        const textarea = mesBlock.find('textarea').first();
        if (textarea.length > 0) {
            window._catCapturedText.set(msgId, textarea.val());
            console.log(`[CAT] 📸 mousedown 캡처 #${msgId}: ${textarea.val().substring(0, 40)}...`);
        }
        markTranslatedEditSave(msgId, textarea.length > 0 ? textarea.val() : null, editChatRef);
    });
    
    // 🚨 ST 저장 체크 버튼(✓) 클릭 직접 감지
    $(document).on('click', '.mes_edit_done, .mes_edit_save, .edit_mes_save, [class*="mes_edit_done"]', function () {
        const mesBlock = $(this).closest('.mes');
        const msgId = parseInt(mesBlock.attr('mesid'));
        const editChatRef = getLiveChat();
        
        // 클릭 시점에 textarea 값 캡처 (가장 확실한 영어 원본 백업)
        const $textarea = mesBlock.find('textarea').first();
        let capturedNow = null;
        if ($textarea.length > 0) {
            capturedNow = $textarea.val();
            window._catCapturedText.set(String(msgId), capturedNow);
        }
        
        const captured = capturedNow || window._catCapturedText.get(String(msgId));
        markTranslatedEditSave(msgId, capturedNow ?? captured ?? null, editChatRef);
        window._catCapturedText.delete(String(msgId));
        
        console.log(`[CAT] ✓ 저장 #${msgId} 캡처: ${captured ? captured.substring(0, 50) : '없음'}`);
        setTimeout(() => handleEditSaved(msgId, captured, editChatRef), 500);
    });
    
    // 🚨 편집 저장 통합 핸들러
    async function handleEditSaved(msgId, capturedText = null, expectedChatRef = getLiveChat()) {
        if (getLiveChat() !== expectedChatRef) return;
        const id = parseInt(typeof msgId === 'object' ? msgId.messageId : msgId);
        const msg = expectedChatRef?.[id];
        if (!msg) return;
        if (isTranslatedEditActive(id, expectedChatRef)) {
            markTranslatedEditSave(id, capturedText, expectedChatRef);
            console.log(`[CAT] 🐟 번역문 편집 저장은 전용 세션에서 처리 #${id}`);
            return;
        }
        if (msg.is_user) {
            if (getInternalInputState(msg)) {
                await handleInternalInputSourceEdit(id, capturedText, expectedChatRef);
            }
            return;
        }
        if (msg.is_system === true || msg.extra?.media?.length > 0) return;
        if (!msg.extra?.original_mes) return;
        
        const mode = settings.afterEditMode || 'notify';
        if (mode === 'keep') return;
        
        // 새 원문 결정: captured(영어 백업)가 있으면 우선, 없으면 msg.mes
        let newOriginal = msg.mes;
        const capturedIsKorean = capturedText && /[가-힣]/.test(capturedText) && capturedText.length > 10;
        const mesIsKorean = /[가-힣]/.test(msg.mes) && msg.mes.length > 10;
        const origIsKorean = /[가-힣]/.test(msg.extra.original_mes) && msg.extra.original_mes.length > 10;
        
        // 🚨 영어 원본 자체가 손상된 경우 (original_mes가 한국어)
        if (origIsKorean) {
            catNotify(`${getThemeEmoji()} 이 메시지는 영어 원본이 손상됐어요. ST 🔄 재생성으로 복구하세요.`, "warning");
            return;
        }
        
        if (capturedText && !capturedIsKorean) {
            newOriginal = capturedText;
        } else if (mesIsKorean) {
            // msg.mes가 한국어로 오염 + captured도 없음 → 원문 보존만
            msg.mes = msg.extra.original_mes;
            stContext.updateMessageBlock(id, msg);
            return;
        }
        
        // 영어가 실제로 수정되었는지 확인
        if (isSameSourceForEdit(newOriginal, msg.extra.original_mes)) {
            console.log(`[CAT] 🫧 저장 형식 차이 무시 #${id} (원문 수정 아님)`);
            return;
        }
        // 🚨 v1.1.11 (Q): 진행 중 번역 양보 — 폴러(3초 백업)가 이후 재시도하므로
        // 여기서 소비하지 않고 물러난다 (진행 중 번역 중단 방지).
        const inflightEdit = _activeTranslationAborts.get(parseInt(id, 10));
        if (inflightEdit && !inflightEdit.signal.aborted) return;
        
        console.log(`[CAT] ✏️ 원문 갱신 #${id}: "${msg.extra.original_mes.substring(0,30)}..." → "${newOriginal.substring(0,30)}..."`);
        
        // 새 원문 적용
        msg.mes = newOriginal;
        msg.extra.original_mes = newOriginal;
        
        if (mode === 'auto') {
            delete msg.extra.display_text;
            delete msg.extra.cat_literal;
            delete msg.extra.cat_prev_display;
            if (msg.extra.swipe_translations && msg.swipe_id !== undefined) {
                delete msg.extra.swipe_translations[msg.swipe_id];
            }
            delete msg.extra.cat_swipe_id;
            $(`.mes[mesid="${id}"]`).removeAttr('data-cat-translated');
            stContext.updateMessageBlock(id, msg);
            catNotify(`${getThemeEmoji()} 원문 수정 감지 → 자동 재번역 중...`, "info");
            const modelKey = getCacheModelKey(settings, SillyTavern.getContext());
            const targetLang = detectLanguageDirection(msg.mes, settings).targetLang;
            deleteCached(msg.mes, targetLang, modelKey);
            setTimeout(() => {
                if (getLiveChat() !== expectedChatRef) return;
                processMessage(id, false, null, false, true);
            }, 300);
        }
    }
    
    // 🚨 ui.js의 직접 핸들러에서 호출할 수 있도록 window에 노출
    window._catHandleEditSaved = handleEditSaved;
    
    const bodyObserver = new MutationObserver(() => { applyTheme(getCurrentTheme()); }); bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // 🚨 캐릭터 전환 시 번역 프롬프트 자동 로드
    stContext.eventSource.on(stContext.event_types.CHAT_CHANGED, () => {
        abortBulkTranslation();
        cancelPendingTranslationWork('CHAT_CHANGED');
        clearTranslatedEditSessions();
        setTimeout(() => {
            // 🚨 채팅 로드 시 오염 자동 검사 + 복구 (msg.mes에 한국어가 들어간 경우)
            const ctx = SillyTavern?.getContext?.();
            if (ctx?.chat) {
                let fixedCount = 0;
                ctx.chat.forEach((msg, i) => {
                    const repaired = repairAssistantMessageState(msg, i, 'CHAT_CHANGED preset');
                    if (repaired.changed) fixedCount++;
                });
                if (fixedCount > 0) {
                    console.warn(`[CAT] 🔧 채팅 로드 시 ${fixedCount}개 메시지 원문 자동 복구`);
                    scheduleChatSave('chat changed repair');
                }
            }

            // 🚨 전환 시점의 최신 캐릭터 이름 사용
            const charName = (SillyTavern?.getContext?.()?.name2) || stContext.name2 || '';
            if (!charName || charName === 'SillyTavern System') return;
            console.log(`[CAT] 📋 캐릭터 전환: "${charName}", 매핑: ${settings.charPresetMap?.[charName] || '없음'}`);
            
            // 🚨 프리셋 로드 전: 대기 중인 autoSave 취소 + 억제 ON
            clearPendingAutoSave();
            setSuppressAutoSave(true);
            _isPresetLoading = true;
            
            const presetName = settings.charPresetMap?.[charName];
            if (presetName && settings.promptPresets?.[presetName]) {
                const preset = settings.promptPresets[presetName];
                settings.commonPrompt = preset.commonPrompt ?? preset.prompt ?? '';
                settings.narrationPrompt = preset.narrationPrompt ?? '';
                settings.dialoguePrompt = preset.dialoguePrompt ?? '';
                settings.temperature = preset.temperature ?? 0.3;
                settings.style = preset.style || 'normal';
                $('#ct-common-prompt').val(settings.commonPrompt);
                $('#ct-narration-prompt').val(settings.narrationPrompt);
                $('#ct-dialogue-prompt').val(settings.dialoguePrompt);
                $('#ct-style').val(settings.style);
                $('#ct-temperature').val(settings.temperature);
                $('#ct-prompt-preset').val(presetName);
                // 🚨 직접 저장 (autoSave 디바운스 충돌 방지) + baseline 영구 보존
                extension_settings[EXT_NAME] = { ...settings, _baseline: { ..._globalBaseline } };
                stContext.saveSettingsDebounced();
                catNotify(`${getThemeEmoji()} ${charName} → 프롬프트 "${presetName}" 자동 로드!`, "success");
                console.log(`[CAT] 🔗 프리셋 적용: "${presetName}" →`, { style: settings.style, temp: settings.temperature, common: settings.commonPrompt.substring(0, 30), narration: settings.narrationPrompt.substring(0, 30), dialogue: settings.dialoguePrompt.substring(0, 30) });
            } else {
                // 🚨 FIX: 매핑 없는 캐릭터 → 전역 baseline으로 복원 (하드코딩 기본값 X)
                settings.commonPrompt = _globalBaseline.commonPrompt;
                settings.narrationPrompt = _globalBaseline.narrationPrompt;
                settings.dialoguePrompt = _globalBaseline.dialoguePrompt;
                settings.temperature = _globalBaseline.temperature;
                settings.style = _globalBaseline.style;
                $('#ct-common-prompt').val(settings.commonPrompt);
                $('#ct-narration-prompt').val(settings.narrationPrompt);
                $('#ct-dialogue-prompt').val(settings.dialoguePrompt);
                $('#ct-style').val(settings.style);
                $('#ct-temperature').val(settings.temperature);
                $('#ct-prompt-preset').val('');
                // 🚨 직접 저장 + baseline 영구 보존
                extension_settings[EXT_NAME] = { ...settings, _baseline: { ..._globalBaseline } };
                stContext.saveSettingsDebounced();
                console.log(`[CAT] 🏠 baseline 복원 (기본 설정):`, { style: _globalBaseline.style, temp: _globalBaseline.temperature, common: _globalBaseline.commonPrompt.substring(0, 30) || '(없음)', narration: _globalBaseline.narrationPrompt.substring(0, 30) || '(없음)', dialogue: _globalBaseline.dialoguePrompt.substring(0, 30) || '(없음)' });
            }
            
            // 🚨 프리셋 로드 완료: 억제 OFF
            _isPresetLoading = false;
            setSuppressAutoSave(false);
        }, 500);
    });
    console.log('[CAT] 🐱 Translator v1.1.0 로드 완료!');
    
    // 🚨 페이지 가시성 변경 시 60초 이상 stuck 글로우 정리 (모바일 백그라운드 복귀 대응)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            $('.cat-mes-trans-btn .cat-emoji-icon.cat-glow-anim, #cat-input-btn .cat-emoji-icon.cat-glow-anim').each(function () {
                const startTime = parseInt($(this).attr('data-cat-glow-start') || '0');
                const elapsed = Date.now() - startTime;
                if (startTime > 0 && elapsed > 180000) {
                    $(this).removeClass('cat-glow-anim').removeAttr('data-cat-glow-start');
                    console.warn(`[CAT] 🔧 visibility 복귀 → stuck 글로우 정리 (${Math.round(elapsed/1000)}s)`);
                }
            });
        }
    });
    
    // 🚨 원문 오염 방어: msg.mes에 한국어가 들어가면 자동 복구
    // ST 내부 렌더링/저장 과정에서 display_text가 msg.mes로 역류하는 현상 방지
    function repairContamination(source = '') {
        const ctx = SillyTavern?.getContext?.();
        if (!ctx?.chat) return;
        let repaired = 0;
        ctx.chat.forEach((msg, i) => {
            const result = repairAssistantMessageState(msg, i, source);
            if (result.changed) { repaired++; ctx.updateMessageBlock?.(i, msg); }
        });
        if (repaired > 0) {
            console.warn(`[CAT] 🛡️ 원문 오염 자동복구: ${repaired}개 (${source})`);
            scheduleChatSave(`contamination ${source}`);
        }
    }
    
    // 🚨 스와이프별 번역 자동 복원: 채팅 진입 시 각 메시지의 현재 swipe에 맞는 번역 복원
    function restoreSwipeTranslations(source = '') {
        const ctx = SillyTavern?.getContext?.();
        if (!ctx?.chat) return;
        let restored = 0;
        let discarded = 0;
        ctx.chat.forEach((msg, i) => {
            if (msg.is_user) return;
            if (!msg.extra?.swipe_translations) return;
            if (msg.swipe_id === undefined) return;
            
            const currentSwipeData = msg.extra.swipe_translations[msg.swipe_id];
            if (!currentSwipeData?.display_text) return;
            const currentSwipeText = getCurrentSwipeText(msg);
            const sourceMatches = !!currentSwipeData.original_mes &&
                (!currentSwipeText ||
                    currentSwipeText === currentSwipeData.original_mes ||
                    msg.mes === currentSwipeData.original_mes);
            if (!sourceMatches) {
                console.warn(`[CAT] 🧹 swipe 원문 불일치 번역 폐기 #${i}/swipe ${msg.swipe_id}`);
                delete msg.extra.swipe_translations[msg.swipe_id];
                discarded++;
                return;
            }
            
            // 현재 표시되는 번역이 이번 swipe와 다르면 복원
            if (msg.extra.cat_swipe_id !== msg.swipe_id || msg.extra.display_text !== currentSwipeData.display_text) {
                msg.extra.original_mes = currentSwipeData.original_mes;
                msg.extra.display_text = currentSwipeData.display_text;
                msg.extra.cat_swipe_id = msg.swipe_id;
                restored++;
            }
        });
        if (restored > 0 || discarded > 0) {
            console.log(`[CAT] 🔄 swipe 번역 복원 ${restored}개 / 폐기 ${discarded}개 (${source})`);
            scheduleChatSave(`swipe restore ${source}`);
        }
    }
    
    // 채팅 진입 시 즉시 복구
    stContext.eventSource.on(stContext.event_types.CHAT_CHANGED, () => {
        setTimeout(() => { repairContamination('CHAT_CHANGED'); restoreSwipeTranslations('CHAT_CHANGED'); }, 300);
    });
    
    // 메시지 렌더 시 복구 (AI 응답 생성 전에 오염 제거)
    stContext.eventSource.on(stContext.event_types.CHARACTER_MESSAGE_RENDERED, () => {
        reconcilePendingInternalInput();
        repairContamination('MESSAGE_RENDERED');
    });

    const generationStartedEvent = stContext.event_types.GENERATION_STARTED;
    if (generationStartedEvent) {
        stContext.eventSource.on(generationStartedEvent, () => {
            reconcilePendingInternalInput();
            repairContamination('GENERATION_STARTED');
        });
    }
    
    // 5초 간격 상시 감시
    setInterval(() => repairContamination('watchdog'), 5000);
    
    // 동일 상태의 언어 검사는 WeakMap으로 생략하며, 감시 주기는 5초 하나로 통합한다.

    // 최초 로드 시 복구
    setTimeout(() => { repairContamination('init'); restoreSwipeTranslations('init'); }, 1500);
    
    // 🚨 채팅 파일 관리 미리보기 번역
    setupChatPreviewTranslation();
});

// 🚨 채팅 파일 관리 팝업의 미리보기 메시지 번역
function setupChatPreviewTranslation() {
    const _previewProcessed = new WeakSet(); // 이미 처리한 DOM 노드
    let _queueProcessing = false;
    let _headerButtonInjected = false;
    let _cancelRequested = false; // 중단 요청 플래그
    
    // 후보 셀렉터들 (ST 버전마다 다를 수 있음)
    const PREVIEW_SELECTORS = [
        // ST 표준 채팅 파일 관리 셀렉터
        '.select_chat_block_message',
        '.select_chat_block_mes',
        '.select_chat_block_mes_text',
        '.select_chat_block .mes_text',
        '.select_chat_block_chat_preview',
        '.select_chat_block_filename + div',  // 파일명 다음 div (미리보기일 가능성)
        // 광범위 매칭
        '[class*="chat_preview"]',
        '[class*="select_chat"] [class*="message"]',
        '[class*="select_chat"] [class*="mes"]',
        '#select_chat_div [class*="mes"]',
        '#shadow_select_chat_popup [class*="mes"]',
        '.last_mes_text',
        '.preview_text'
    ];
    
    // 영문 미리보기 텍스트인지 검사
    function isEnglishPreview(text) {
        if (!text || text.length < 20) return false;
        // 한국어가 30% 이상이면 이미 번역됨
        const korean = (text.match(/[가-힣]/g) || []).length;
        if (korean / text.length > 0.3) return false;
        // 영문이 50% 이상이어야 영문 미리보기
        const english = (text.match(/[a-zA-Z]/g) || []).length;
        if (english / text.length > 0.5) return true;
        // 🚨 fallback: yaml/태그/기호가 많아 영문 비율이 희석된 경우 — 한글 대비 상대 비교
        // (영문 40자 이상 + 한글이 영문의 10% 미만이면 영어 미리보기로 판정)
        if (english >= 40 && korean < english * 0.1) return true;
        return false;
    }
    
    // 미리보기 요소들 찾기
    function findPreviewElements() {
        const elements = [];
        for (const selector of PREVIEW_SELECTORS) {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    if (_previewProcessed.has(el)) return;
                    const text = el.textContent?.trim();
                    if (isEnglishPreview(text)) {
                        elements.push({ el, text });
                    }
                });
            } catch (e) {}
        }
        return elements;
    }
    
    // 미리보기 한 개 번역
    async function translatePreview(el, text, modeOverride = null, force = false, modelType = null) {
        if (_previewProcessed.has(el)) return null;
        _previewProcessed.add(el);
        
        let mode = modeOverride || settings.previewTranslate || 'off';
        if (mode === 'cache' || mode === 'auto') mode = 'on';
        if (mode === 'off') return null;
        
        const targetLang = settings.targetLang || 'Korean';
        
        // 🚨 modelType에 따라 임시 settings 만들기
        let effectiveSettings = settings;
        if (modelType === 'pro') {
            effectiveSettings = { ...settings, profile: '', directModel: 'gemini-2.5-pro', customModelName: '' };
        } else if (modelType === 'flash') {
            effectiveSettings = { ...settings, profile: '', directModel: 'gemini-2.5-flash', customModelName: '' };
        }
        
        const modelKey = getCacheModelKey(effectiveSettings, SillyTavern.getContext());
        
        try {
            // 1. 캐시 우선 조회 (짧은 시도)
            const { getCached } = await import('./cache.js');
            const cached = await getCached(text, targetLang, modelKey);
            
            if (cached) {
                if (!el.dataset.catOriginalPreview) {
                    el.dataset.catOriginalPreview = text;
                }
                el.textContent = cached.translated;
                el.style.opacity = '1';
                el.title = `🐱 원문: ${text.substring(0, 100)}...`;
                console.log(`[CAT] 📁 미리보기 캐시 히트 (${modelType || 'default'})`);
                return 'cached';
            }
            
            // 2. 캐시 없음 → API 호출
            el.style.opacity = '0.5';
            el.style.fontStyle = 'italic';
            
            const { fetchTranslation } = await import('./translator.js');
            const result = await fetchTranslation(text, effectiveSettings, stContext, { 
                forceLang: targetLang,
                silent: !force
            });
            
            if (result && result.text) {
                if (!el.dataset.catOriginalPreview) {
                    el.dataset.catOriginalPreview = text;
                }
                el.textContent = result.text;
                el.style.opacity = '1';
                el.style.fontStyle = 'normal';
                el.title = `🐱 원문 (${modelType || 'default'}): ${text.substring(0, 100)}...`;
                console.log(`[CAT] 📁 미리보기 번역 완료 (${modelType || 'default'})`);
                return 'translated';
            } else {
                el.style.opacity = '1';
                el.style.fontStyle = 'normal';
                _previewProcessed.delete(el);
                return null;
            }
        } catch (e) {
            console.warn(`[CAT] 미리보기 번역 실패:`, e);
            el.style.opacity = '1';
            el.style.fontStyle = 'normal';
            _previewProcessed.delete(el);
            if (force) catNotify(`${getThemeEmoji()} ❌ 번역 에러: ${e.message?.substring(0, 50)}`, "error");
            return null;
        }
    }
    
    // 🚨 미리보기 마크업 정리 (yaml/HTML 태그/info_panel 등 숨김)
    function cleanupPreviewText(text) {
        if (!text) return text;
        let cleaned = text;
        
        // 1. ST 시스템 HTML 태그 제거 (정리할 대상 태그 목록)
        const SYSTEM_TAGS = '(?:memo|small|info_panel|status_box|character_card|chat_box|world_info|no_history|history|details|summary|narrator_note|user_note|scene|location|time|details_panel|stats|stat_block|sys|system|inventory|state|status)';
        // 여는 태그와 닫는 태그 모두 제거 (속성 포함)
        cleaned = cleaned.replace(new RegExp(`</?${SYSTEM_TAGS}(?:\\s+[^>]*)?>`, 'gi'), '');
        
        // 2. 코드블록 마커 제거 (```yaml, ```json, ``` 등)
        cleaned = cleaned.replace(/```[a-zA-Z]*\s*/g, '');
        cleaned = cleaned.replace(/```/g, '');
        
        // 3. 수평선 제거 (___, ---, ***)
        cleaned = cleaned.replace(/^[ \t]*[_\-*]{3,}[ \t]*$/gm, '');
        
        // 4. yaml 형식의 메타 데이터 라인 제거 (- 키: 값 형태)
        // 예: "- 시간: 2025년", "- 등장인물: 김홍진"
        cleaned = cleaned.replace(/^[ \t]*-\s*[가-힣\w][가-힣\w\s]*:\s*.+$/gm, '');
        
        // 5. 빈 줄 정리 (3개 이상 → 2개)
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
        
        // 6. 너무 짧아지면 (예: 다 정리해서 거의 안 남음) 원본 일부라도 살리기
        if (cleaned.length < 20 && text.length > 100) {
            // 원본에서 첫 200자만 ASCII/한글 기준으로 추출
            return text.substring(0, 200) + (text.length > 200 ? '...' : '');
        }
        
        return cleaned;
    }
    
    // 큐에 쌓인 미리보기 순차 처리 (rate limit 방지)
    async function processQueue(force = false) {
        // 🚨 무한 "이미 처리 중" 알림 방지: 조용히 return
        if (_queueProcessing) {
            if (force) catNotify(`${getThemeEmoji()} 이미 처리 중이에요. 잠시 기다려주세요`, "info");
            return;
        }
        
        const translateMode = settings.previewTranslate || 'off';
        const cleanupMode = settings.previewCleanup || 'off';
        
        // 자동 옵저버는 cleanup만 (force 모드에서만 번역 실행)
        if (!force && cleanupMode === 'off') return;
        
        _queueProcessing = true;
        _cancelRequested = false;
        if (force) showCancelButton(true);
        let cleanupCount = 0;
        let translateCount = 0;
        
        try {
            // 🚨 마크업 정리는 모든 미리보기 (영문/한국어) 대상
            // force 또는 cleanupMode === 'on'
            if (force || cleanupMode === 'on') {
                for (const selector of PREVIEW_SELECTORS) {
                    try {
                        document.querySelectorAll(selector).forEach(el => {
                            if (el.dataset.catCleanupDone === 'true') return;
                            const text = el.textContent?.trim();
                            if (!text || text.length < 30) return;
                            
                            const cleaned = cleanupPreviewText(text);
                            if (cleaned !== text && cleaned.length > 0) {
                                if (!el.dataset.catOriginalPreview) {
                                    el.dataset.catOriginalPreview = text;
                                }
                                el.textContent = cleaned;
                                el.dataset.catCleanupDone = 'true';
                                el.title = `🐱 원본 보기 (정리 전)`;
                                cleanupCount++;
                            }
                        });
                    } catch (e) {}
                }
            }
            
            // 🚨 번역은 force 모드(헤더 버튼 클릭)에서만 실행
            // 자동 옵저버는 cleanup만 → 무한 루프 방지
            if (force) {
                const elements = findPreviewElements();
                if (elements.length > 0) {
                    console.log(`[CAT] 📁 미리보기 ${elements.length}개 발견 (번역 대상)`);
                    
                    catNotify(`${getThemeEmoji()} 미리보기 ${elements.length}개 번역 시작`, "info");
                    updateHeaderProgress(0, elements.length);
                    
                    // 1초 간격으로 순차 처리 (API rate limit 방지)
                    for (let i = 0; i < elements.length; i++) {
                        // 🚨 중단 체크
                        if (_cancelRequested) {
                            catNotify(`${getThemeEmoji()} ⛔ 중단됨 (${i}/${elements.length})`, "warning");
                            break;
                        }
                        
                        const { el, text } = elements[i];
                        const result = await translatePreview(el, text, 'on', true);
                        if (result === 'translated' || result === 'cached') translateCount++;
                        
                        updateHeaderProgress(i + 1, elements.length);
                        
                        await new Promise(r => setTimeout(r, 800)); // 0.8초 간격
                    }
                }
            }
            
            // 강제 모드면 결과 알림
            if (force) {
                const msgs = [];
                if (cleanupCount > 0) msgs.push(`🧹 정리 ${cleanupCount}개`);
                if (translateCount > 0) msgs.push(`📁 번역 ${translateCount}개`);
                if (msgs.length === 0 && !_cancelRequested) msgs.push('처리할 미리보기 없음');
                if (msgs.length > 0) catNotify(`${getThemeEmoji()} ${msgs.join(' / ')}`, "success");
            }
        } finally {
            _queueProcessing = false;
            _cancelRequested = false;
            if (force) showCancelButton(false);
        }
    }
    
    // 헤더 진행 상태 표시
    function updateHeaderProgress(current, total) {
        const btn = document.querySelector('#cat-preview-manual-btn');
        if (btn) {
            const label = btn.querySelector('.cat-btn-label');
            if (label) {
                label.textContent = current < total ? `${current}/${total}` : '번역';
            }
        }
    }
    
    // 중지 버튼 표시/숨김
    function showCancelButton(show) {
        let cancelBtn = document.querySelector('#cat-preview-cancel-btn');
        if (show && !cancelBtn) {
            const header = document.querySelector('#selectChatPopupHeader, [name="selectChatPopupHeader"]');
            if (!header) return;
            cancelBtn = document.createElement('div');
            cancelBtn.id = 'cat-preview-cancel-btn';
            cancelBtn.className = 'menu_button menu_button_icon interactable';
            cancelBtn.style.cssText = 'display:flex; align-items:center; gap:3px; padding:2px 6px; font-size:12px; background:#cc4444; color:white;';
            cancelBtn.innerHTML = `<span>⛔ 중지</span>`;
            cancelBtn.title = '진행 중인 번역 중단';
            cancelBtn.addEventListener('click', () => {
                _cancelRequested = true;
                catNotify(`${getThemeEmoji()} 중단 요청됨 (현재 항목 처리 후 정지)`, "info");
            });
            const manualBtn = header.querySelector('#cat-preview-manual-btn');
            if (manualBtn) header.insertBefore(cancelBtn, manualBtn.nextSibling);
            else header.appendChild(cancelBtn);
        } else if (!show && cancelBtn) {
            cancelBtn.remove();
        }
    }
    
    // 🚨 헤더에 전체 처리 버튼 주입
    function injectHeaderButton() {
        if (_headerButtonInjected && document.querySelector('#cat-preview-manual-btn')) return;
        
        const headers = document.querySelectorAll('#selectChatPopupHeader, [name="selectChatPopupHeader"], [id*="selectChatPopup"][class*="header"]');
        if (headers.length === 0) return;
        
        for (const header of headers) {
            if (header.querySelector('#cat-preview-manual-btn')) continue;
            
            const btn = document.createElement('div');
            btn.id = 'cat-preview-manual-btn';
            btn.className = 'menu_button menu_button_icon interactable';
            btn.setAttribute('role', 'button');
            btn.setAttribute('tabindex', '0');
            // 🚨 컴팩트 스타일 (세로 축소)
            btn.style.cssText = 'display:flex; align-items:center; gap:3px; padding:2px 6px; font-size:13px; line-height:1.2;';
            btn.innerHTML = `<span style="font-size:14px;">${getThemeEmoji ? getThemeEmoji() : '🐯'}</span><span class="cat-btn-label">번역</span>`;
            btn.title = '모든 영문 미리보기 번역 (API 호출, 중지 가능)';
            
            btn.addEventListener('click', () => {
                if (confirm('모든 영문 미리보기를 번역할까요?\n채팅 수만큼 API 호출이 발생합니다.\n\n중간에 ⛔ 중지 버튼으로 멈출 수 있어요.\n개별 번역을 원하면 각 채팅 옆 🐯 버튼을 사용하세요.')) {
                    processQueue(true);
                }
            });
            
            const searchBar = header.querySelector('#select_chat_search, [id*="search"]');
            if (searchBar) {
                header.insertBefore(btn, searchBar);
            } else {
                header.appendChild(btn);
            }
            
            _headerButtonInjected = true;
            console.log(`[CAT] 📁 미리보기 처리 버튼 주입 완료`);
        }
    }
    
    // 🚨 각 채팅 항목에 개별 번역 버튼 주입
    function injectItemButtons() {
        const blocks = document.querySelectorAll('.select_chat_block');
        let injected = 0;
        
        for (const block of blocks) {
            if (block.dataset.catBtnInjected === 'true') continue;
            
            // 미리보기 텍스트 찾기
            const previewEl = block.querySelector('.select_chat_block_mes, .select_chat_block_message');
            if (!previewEl) continue;
            
            const previewText = previewEl.textContent?.trim();
            if (!previewText || previewText.length < 30) continue;
            
            // 🚨 원본 판정 실패 시 마크업 정리 후 텍스트로 재판정 (yaml/태그 희석 대응)
            const isEnglish = isEnglishPreview(previewText) || isEnglishPreview(cleanupPreviewText(previewText));
            
            // 다운로드 버튼 영역 찾기
            const buttonArea = block.querySelector('.flex-container.gap10px:has(.exportRawChatButton), .flex-container.gap10px:has(.PastChat_cross)');
            const targetArea = buttonArea || block.querySelector('.flex-container.alignItemsCenter:last-child');
            if (!targetArea) continue;
            
            // 🚨 사용자 테마 따라 아이콘 자동 결정
            const themeIcon = getThemeEmoji(); // 🐯 또는 🐱
            const doneIcon = getCompletionEmoji(); // 🍖 또는 🐟
            
            // 되돌리기 함수
            const revertItem = (btn, defaultIcon, defaultTitle) => {
                const originalText = previewEl.dataset.catOriginalPreview;
                if (originalText) {
                    previewEl.textContent = originalText;
                    delete previewEl.dataset.catOriginalPreview;
                    delete previewEl.dataset.catCleanupDone;
                    previewEl.title = '';
                    previewEl.style.opacity = '1';
                    previewEl.style.fontStyle = 'normal';
                    _previewProcessed.delete(previewEl);
                }
                btn.dataset.catBtnState = 'ready';
                btn.innerHTML = defaultIcon;
                btn.title = defaultTitle;
            };
            
            // 번역 처리 함수 (사용자 현재 모델 그대로 사용 - 모델 강제 X)
            const handleTranslate = async (btn) => {
                if (btn.dataset.catBtnState === 'done') {
                    revertItem(btn, getThemeEmoji(), '이 채팅 번역 (현재 모델)');
                    return;
                }
                
                btn.style.opacity = '0.3';
                btn.style.pointerEvents = 'none';
                
                try {
                    // 정리 먼저
                    if (previewEl.dataset.catCleanupDone !== 'true') {
                        const cleaned = cleanupPreviewText(previewText);
                        if (cleaned !== previewText && cleaned.length > 0) {
                            if (!previewEl.dataset.catOriginalPreview) {
                                previewEl.dataset.catOriginalPreview = previewText;
                            }
                            previewEl.textContent = cleaned;
                            previewEl.dataset.catCleanupDone = 'true';
                        }
                    }
                    
                    const currentText = previewEl.textContent.trim();
                    if (isEnglishPreview(currentText)) {
                        catNotify(`${getThemeEmoji()} 번역 중...`, "info");
                        // modelType=null → 사용자 현재 모델 그대로 사용
                        const result = await translatePreview(previewEl, currentText, 'on', true, null);
                        if (result === 'translated' || result === 'cached') {
                            btn.dataset.catBtnState = 'done';
                            btn.innerHTML = getCompletionEmoji(); // 🍖 또는 🐟
                            btn.title = '되돌리기 (원문 영어로 복원)';
                            catNotify(`${getThemeEmoji()} ✅ 번역 완료`, "success");
                        } else {
                            btn.innerHTML = '❌';
                            setTimeout(() => { btn.innerHTML = getThemeEmoji(); }, 2000);
                        }
                    } else {
                        btn.innerHTML = '⚠️';
                        catNotify(`${getThemeEmoji()} 한국어인 것 같아요. 🧹로 정리만 하세요`, "warning");
                        setTimeout(() => { btn.innerHTML = getThemeEmoji(); }, 2000);
                    }
                } catch (err) {
                    btn.innerHTML = '❌';
                    catNotify(`${getThemeEmoji()} 처리 실패: ${err.message?.substring(0,50)}`, "error");
                    setTimeout(() => { btn.innerHTML = getThemeEmoji(); }, 2000);
                } finally {
                    btn.style.opacity = '0.7';
                    btn.style.pointerEvents = 'auto';
                }
            };
            
            // 정리만 버튼 (한국어용)
            const handleCleanup = async (btn) => {
                if (btn.dataset.catBtnState === 'done') {
                    revertItem(btn, '🧹', '이 채팅 마크업 정리');
                    return;
                }
                
                btn.style.opacity = '0.3';
                btn.style.pointerEvents = 'none';
                
                try {
                    if (previewEl.dataset.catCleanupDone !== 'true') {
                        const cleaned = cleanupPreviewText(previewText);
                        if (cleaned !== previewText && cleaned.length > 0) {
                            if (!previewEl.dataset.catOriginalPreview) {
                                previewEl.dataset.catOriginalPreview = previewText;
                            }
                            previewEl.textContent = cleaned;
                            previewEl.dataset.catCleanupDone = 'true';
                            btn.dataset.catBtnState = 'done';
                            btn.innerHTML = '✨';
                            btn.title = '되돌리기 (원본 그대로 복원)';
                            catNotify(`${getThemeEmoji()} 정리 완료`, "success");
                        } else {
                            btn.innerHTML = 'ℹ️';
                            catNotify(`${getThemeEmoji()} 정리할 게 없어요 (이미 깔끔함)`, "info");
                            setTimeout(() => { btn.innerHTML = '🧹'; }, 2000);
                        }
                    }
                } catch (err) {
                    btn.innerHTML = '❌';
                    setTimeout(() => { btn.innerHTML = '🧹'; }, 2000);
                } finally {
                    btn.style.opacity = '0.7';
                    btn.style.pointerEvents = 'auto';
                }
            };
            
            // 🚨 한 채팅에 한 버튼만 (테마 따라 호랑이/고양이 자동)
            const btn = document.createElement('div');
            btn.className = 'cat-item-translate-btn opacity50p hoverglow';
            btn.style.cssText = 'cursor:pointer; font-size:14px; padding:0 4px;';
            btn.dataset.catBtnState = 'ready';
            
            if (isEnglish) {
                btn.innerHTML = themeIcon;
                btn.title = `이 채팅 번역 (현재 모델)`;
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    await handleTranslate(btn);
                });
            } else {
                btn.innerHTML = '🧹';
                btn.title = '이 채팅 마크업 정리 (yaml/태그 숨김, 비용 0)';
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    await handleCleanup(btn);
                });
            }
            
            targetArea.insertBefore(btn, targetArea.firstChild);
            block.dataset.catBtnInjected = 'true';
            injected++;
        }
        
        if (injected > 0) console.log(`[CAT] 📁 개별 버튼 ${injected}개 주입 (테마: ${getThemeEmoji()})`);
    }
    
    // MutationObserver: 채팅 팝업 등장 감지
    const previewObserver = new MutationObserver(() => {
        // 🚨 버튼은 옵션 OFF여도 항상 주입 (사용자가 수동 실행 가능)
        injectHeaderButton();
        injectItemButtons();
        
        // 🚨 자동 옵저버는 cleanup만 실행 (번역은 무한 루프 위험 → 수동만)
        const cleanupMode = settings.previewCleanup || 'off';
        if (cleanupMode === 'off') return;
        // debounce - 500ms 후 한 번만 처리
        clearTimeout(previewObserver._debounce);
        previewObserver._debounce = setTimeout(() => processQueue(false), 500);
    });
    previewObserver.observe(document.body, { childList: true, subtree: true });
    
    console.log(`[CAT] 📁 채팅 미리보기 옵저버 등록 (정리만 자동, 번역은 수동)`);
}
