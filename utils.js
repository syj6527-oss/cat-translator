// ============================================================
// 🐱 Cat Translator v18.0.0 - utils.js
// 유틸리티: 알림, 정규식 세탁기, HTML/CSS 방어, 언어 감지
// ============================================================

// ─── 테마 이모지 헬퍼 ──────────────────────────────────
export function getThemeEmoji() {
    const theme = document.body.getAttribute('data-cat-theme');
    return theme === 'tiger' ? '🐯' : '🐱';
}

// ─── 3색 스마트 토스트 알림 (알약 디자인) ──────────────
export function catNotify(message, type = 'success') {
    $('.cat-notification').remove();
    const emoji = getThemeEmoji();
    const colors = {
        success: '#2ecc71',
        warning: '#f39c12',
        error: '#e74c3c',
        progress: '#f39c12'
    };
    const bgColor = colors[type] || colors.success;
    const displayMsg = message.replace(/^(🐱|🐯)\s*/, `${emoji} `);
    const notifyHtml = $(`<div class="cat-notification cat-native-font" style="background-color: ${bgColor};">${displayMsg}</div>`);
    $('body').append(notifyHtml);
    requestAnimationFrame(() => notifyHtml.addClass('show'));

    if (type !== 'progress') {
        setTimeout(() => {
            notifyHtml.removeClass('show');
            setTimeout(() => notifyHtml.remove(), 500);
        }, 2500);
    }
    return notifyHtml;
}

// ─── 진행률 토스트 (클릭시 중단) ─────────────────────
export function catNotifyProgress(message, onAbort) {
    const el = catNotify(message, 'progress');
    if (onAbort) {
        el.css({ cursor: 'pointer', pointerEvents: 'auto' });
        el.on('click', () => {
            onAbort();
            el.removeClass('show');
            setTimeout(() => el.remove(), 500);
        });
    }
    return el;
}

// ─── 정규식 세탁기 (cleanResult 강화) ──────────────────
export function cleanResult(text) {
    if (!text) return "";
    return text
        .replace(/^(번역|Translation|Output|Input|Result):\s*/gi, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// ─── 모델 테마 판별 (프리셋 이름도 감지) ──────────────
export function getModelTheme(modelName) {
    if (!modelName) return 'cat';
    const lower = modelName.toLowerCase();
    if (lower.includes('pro')) return 'tiger';
    return 'cat';
}

// ─── 언어 감지 (70% 룰) ─────────────────────────────
export function detectLanguageDirection(text, settings) {
    const korCount = (text.match(/[가-힣]/g) || []).length;
    const engCount = (text.match(/[a-zA-Z]/g) || []).length;
    const jpCount = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const cnCount = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
    const total = korCount + engCount + jpCount + cnCount;

    if (total === 0) return { isToEnglish: false, targetLang: settings.targetLang };

    const korRatio = korCount / total;
    const engRatio = engCount / total;

    // 한↔영 스마트 감지 (목표 언어 무관)
    if (korRatio >= 0.7) {
        return { isToEnglish: true, targetLang: 'English' };
    }
    if (engRatio >= 0.7) {
        return { isToEnglish: false, targetLang: 'Korean' };
    }

    // 70% 미만이면 설정된 목표 언어로
    return { isToEnglish: false, targetLang: settings.targetLang };
}

// ─── 사전 치환 (Pre-swap) ──────────────────────────────
export function applyPreReplace(text, dictionary, isToEnglish) {
    if (!dictionary || dictionary.trim() === "") return text;
    const lines = dictionary.split('\n').filter(l => l.includes('='));
    if (lines.length === 0) return text;

    let result = text;
    // 긴 단어 우선 치환 (정확도 향상)
    lines.sort((a, b) => b.split('=')[0].length - a.split('=')[0].length);

    lines.forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const orig = parts[0].trim();
            const trans = parts.slice(1).join('=').trim();
            const searchStr = isToEnglish ? trans : orig;
            const replaceStr = isToEnglish ? orig : trans;
            if (searchStr && replaceStr) {
                const escaped = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), replaceStr);
            }
        }
    });
    return result;
}

// ─── 텍스트 정규화 (캐시 키 생성용) ───────────────────
export function normalizeText(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^a-z가-힣0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '').trim();
}

// ─── 네이티브 textarea 값 설정 ────────────────────────
export function setTextareaValue(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
    )?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
    $(el).val(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}
