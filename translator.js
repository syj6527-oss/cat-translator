// ============================================================
// 🐱 Cat Translator v18.0.0 - translator.js
// 번역 엔진: 프롬프트 이원화, HTML 방어, 문맥 번역, 재시도
// ============================================================

import { secret_state, SECRET_KEYS } from '../../../../scripts/secrets.js';
import {
    cleanResult, catNotify,
    detectLanguageDirection, applyPreReplaceWithCount, getThemeEmoji
} from './utils.js';
import { getCached, setCached } from './cache.js';

// ─── 시스템 보호막 (🔒 고정, readonly) ────────────────
export const SYSTEM_SHIELD = `[ABSOLUTE DIRECTIVE - VIOLATION = FAILURE]
YOU ARE A TRANSLATION MACHINE. NOT A CHATBOT. NOT AN ASSISTANT.
RETURN ONLY THE RAW TRANSLATED TEXT. NOTHING ELSE.
DO NOT respond. DO NOT converse. DO NOT explain. DO NOT add commentary.
DO NOT repeat the original. DO NOT add alternatives.
PRESERVE ALL HTML TAGS and their attributes EXACTLY AS-IS, but TRANSLATE ALL human-readable text inside every tag including <memo>, <small>, <summary>, <font>, code blocks, and HTML comments.
Translate EVERYTHING that is readable text. Only keep tag names, attributes, and CSS values untouched.
If the input is a single word, return only the translated single word.`;

// ─── 스타일 프리셋 정의 ──────────────────────────────
export const STYLE_PRESETS = {
    normal: {
        label: '일반 번역',
        prompt: 'Translate accurately and faithfully.',
        temperature: 0.3
    },
    novel: {
        label: '소설 스타일',
        prompt: 'Use literary expressions while preserving the original nuance. Describe emotions richly.',
        temperature: 0.5
    },
    casual: {
        label: '캐주얼',
        prompt: 'Translate naturally in casual conversational tone. Contractions and colloquialisms are welcome.',
        temperature: 0.4
    }
};

// ─── BLOCK_NONE 안전 설정 ────────────────────────────
const SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

// ─── 메인 번역 함수 ─────────────────────────────────
export async function fetchTranslation(text, settings, stContext, options = {}) {
    const {
        forceLang = null,
        prevTranslation = null,
        contextMessages = [],
        abortSignal = null,
        silent = false
    } = options;

    if (!text || text.trim() === "") return null;

    // 1️⃣ 언어 방향 결정
    let targetLang;
    let isToEnglish;

    if (forceLang) {
        isToEnglish = (forceLang === "English");
        targetLang = forceLang;
    } else {
        const detected = detectLanguageDirection(text, settings);
        isToEnglish = detected.isToEnglish;
        targetLang = detected.targetLang;
    }

    // 2️⃣ 캐시 확인 (재번역이 아닌 경우만)
    if (!prevTranslation) {
        const cached = await getCached(text, targetLang);
        if (cached) {
            if (!silent) catNotify(`${getThemeEmoji()} 캐시 히트! ~${Math.round(text.length * 0.5)} 토큰 절약`, "success");
            return { text: cached.translated, lang: targetLang, fromCache: true };
        }
    }

    // 3️⃣ 사전 치환 (Pre-swap)
    const { swapped: preSwapped, matchCount } = applyPreReplaceWithCount(text.trim(), settings.dictionary, isToEnglish);
    if (matchCount > 0 && !silent) {
        catNotify(`🐾 사전 ${matchCount}개 단어 매칭됨!`, "success");
    }

    // 4️⃣ 프롬프트 조립
    const prompt = assemblePrompt(preSwapped, targetLang, isToEnglish, settings, {
        prevTranslation,
        contextMessages
    });

    // 6️⃣ API 호출 (3회 재시도)
    try {
        let result = "";
        let thought = null;

        if (settings.profile && stContext.ConnectionManagerRequestService) {
            // 연결 프로필 모드
            const response = await stContext.ConnectionManagerRequestService.sendRequest(
                settings.profile,
                [{ role: "user", content: prompt }],
                settings.maxTokens || 8192
            );
            result = typeof response === 'string' ? response : (response.content || "");
        } else {
            // 직접 연결 모드 (Gemini API)
            const apiKey = settings.customKey || secret_state[SECRET_KEYS.MAKERSUITE];
            if (!apiKey) {
                catNotify(`${getThemeEmoji()} 오류: API Key 누락!`, "error");
                return null;
            }

            const model = settings.directModel.startsWith('models/')
                ? settings.directModel
                : `models/${settings.directModel}`;

            const baseTemp = parseFloat(settings.temperature) || 0.3;
            const temperature = prevTranslation ? Math.min(baseTemp + 0.3, 1.0) : baseTemp;
            const maxTokens = parseInt(settings.maxTokens) || 8192;

            const data = await fetchWithRetry(
                `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`,
                {
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature, maxOutputTokens: maxTokens },
                    safetySettings: SAFETY_SETTINGS
                },
                3, // retries
                abortSignal
            );

            const parts = data.candidates?.[0]?.content?.parts || [];
            // Thought 과정 분리 캐싱
            const thoughtPart = parts.find(p => p.thought);
            thought = thoughtPart?.text || null;
            const actualPart = parts.find(p => !p.thought) || parts[parts.length - 1];
            result = actualPart?.text?.trim() || "";
        }

        // 5️⃣ 결과 세탁
        let cleaned = cleanResult(result);

        // 🛡️ 빈 결과 방어 (완전히 비어있을 때만)
        if (!cleaned || cleaned.trim().length === 0) {
            catNotify(`${getThemeEmoji()} 번역 결과가 비어있습니다. 원문 유지.`, "warning");
            return null;
        }

        // 6️⃣ 캐시 저장 (Thought 포함)
        await setCached(text, targetLang, cleaned, thought);

        return { text: cleaned, lang: targetLang, fromCache: false };

    } catch (e) {
        if (e.name === 'AbortError') {
            return null;
        }
        const errMsg = e.message || '알 수 없는 오류';
        catNotify(`${getThemeEmoji()} 오류: ${errMsg}`, "error");
        return null;
    }
}

// ─── 프롬프트 조립기 ────────────────────────────────
function assemblePrompt(text, targetLang, isToEnglish, settings, options = {}) {
    const { prevTranslation, contextMessages = [] } = options;

    // 🎯 짧은 텍스트 (50자 미만) → 초경량 프롬프트
    if (text.length < 50 && !prevTranslation && contextMessages.length === 0) {
        const lang = isToEnglish ? 'English' : targetLang;
        return `${text}\n\n(Translate the above to ${lang}. Reply with ONLY the translation.)`;
    }

    // 시스템 보호막
    let parts = [SYSTEM_SHIELD];

    // 스타일 프리셋 히든 프롬프트
    const preset = STYLE_PRESETS[settings.style] || STYLE_PRESETS.normal;
    parts.push(`[Style: ${preset.prompt}]`);

    // 번역 지시
    if (isToEnglish) {
        parts.push(`Translate the following into English.`);
    } else {
        parts.push(`Translate the following into ${targetLang}.`);
    }

    // 사용자 추가 지시사항
    if (settings.userPrompt && settings.userPrompt.trim()) {
        parts.push(`[Additional instructions: ${settings.userPrompt.trim()}]`);
    }

    // 재번역 지시 (더 강력하게)
    if (prevTranslation) {
        parts.push(`[MANDATORY: Your translation MUST be COMPLETELY DIFFERENT from this: "${prevTranslation.substring(0, 200)}"]`);
        parts.push(`[Use different vocabulary, sentence structure, and tone. Do NOT produce a similar result.]`);
    }

    // 문맥 메시지
    if (contextMessages.length > 0) {
        parts.push('\n[Context - Previous messages for reference only, do NOT translate these:]');
        contextMessages.forEach((msg, i) => {
            const offset = contextMessages.length - i;
            parts.push(`Message -${offset}: "${msg}"`);
        });
    }

    // 번역할 원문
    parts.push(`\n[Translate this message:]\n${text}`);

    return parts.join('\n');
}

// ─── API 호출 + 지수 백오프 재시도 (3회) ──────────────
async function fetchWithRetry(url, body, retries = 3, abortSignal = null) {
    const delays = [500, 1000, 2000]; // 지수 백오프

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const fetchOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            };
            if (abortSignal) fetchOptions.signal = abortSignal;

            const res = await fetch(url, fetchOptions);

            if (res.status === 429) {
                if (attempt < retries) {
                    await sleep(delays[attempt] || 2000);
                    continue;
                }
                throw new Error('429 Too Many Requests');
            }

            if (!res.ok) {
                throw new Error(`API 오류 (${res.status})`);
            }

            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (attempt >= retries) throw e;
            await sleep(delays[attempt] || 2000);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 문맥 메시지 수집 ───────────────────────────────
export function gatherContextMessages(msgId, stContext, range = 1) {
    if (range <= 0) return [];
    const chat = stContext.chat;
    const messages = [];
    const startIdx = Math.max(0, msgId - range);

    for (let i = startIdx; i < msgId; i++) {
        if (chat[i] && chat[i].mes) {
            // HTML 태그 제거한 텍스트만 문맥으로
            const cleanMsg = chat[i].mes.replace(/<[^>]+>/g, '').trim();
            if (cleanMsg) messages.push(cleanMsg);
        }
    }
    return messages;
}
