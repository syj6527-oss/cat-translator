// ============================================================
// 🐱 Translator v1.1.0 - utils.js
// 유틸리티: 알림, 정규식 세탁기, HTML/CSS 방어, 언어 감지
// ============================================================

// ============================================================
// 🚨 beta.5: 구분선 판정 단일 출처 (Single Source of Truth)
// 같은 패턴이 6군데에 복붙되어 있어 한 곳만 고치면 나머지가 어긋나는
// 드리프트 사고를 막기 위해 여기로 통합. 의미는 기존과 동일:
// "-{3,} / _{3,} / *{3,} 만으로 이루어진 한 줄" (앞뒤 공백/NBSP 허용).
// g 플래그 정규식의 lastIndex 상태 공유 사고를 원천 차단하기 위해
// 공유 객체 대신 팩토리로 매번 새 인스턴스를 만든다.
// ============================================================
const DIVIDER_LINE_SRC = '^(?:[\\t \\u00A0]*)(?:-{3,}|_{3,}|\\*{3,})(?:[\\t \\u00A0]*)$';

export function dividerLineRegex(flags = '') {
    return new RegExp(DIVIDER_LINE_SRC, flags);
}

// 구조 시그니처 요소값(매치된 줄 전체, 공백 포함 가능)이 구분선인지 판정
export function isDividerElement(value) {
    return dividerLineRegex().test(String(value ?? ''));
}

// ST 저장/스와이프 동기화가 바꾸는 표현 차이는 사용자 편집으로 보지 않는다.
// 의미 있는 본문 수정은 그대로 구분하되 CRLF↔LF, NFC, 줄끝 공백만 정규화한다.
export function normalizeSourceForEditCompare(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .normalize('NFC')
        .replace(/[\t ]+$/gm, '')
        .trim();
}

export function isSameSourceForEdit(a, b) {
    return normalizeSourceForEditCompare(a) === normalizeSourceForEditCompare(b);
}

export function getThemeEmoji() {
    const theme = document.body.getAttribute('data-cat-theme');
    return theme === 'tiger' ? '🐯' : '🐱';
}

export function getCompletionEmoji() {
    const theme = document.body.getAttribute('data-cat-theme');
    return theme === 'tiger' ? '🍖' : '🐟';
}

export function catNotify(message, type = 'success') {
    // 같은 내용 중복 알림 방지
    const existing = $('.cat-notification');
    let isDuplicate = false;
    existing.each(function() { if ($(this).text() === message) isDuplicate = true; });
    if (isDuplicate) return existing.first();
    
    // 최대 3개까지만 스택, 오래된 것부터 제거
    if (existing.length >= 3) existing.first().removeClass('show').remove();
    
    const emoji = getThemeEmoji();
    const colors = { success: '#2ecc71', warning: '#f39c12', error: '#e74c3c', progress: '#f39c12', autosave: '#1e8449' };
    const bgColor = colors[type] || colors.success;
    const displayMsg = String(message).replace(/^(🐱|🐯)\s*/, `${emoji} `)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const notifyHtml = $(`<div class="cat-notification cat-native-font" style="background-color: ${bgColor};">${displayMsg}</div>`);
    $('body').append(notifyHtml);
    
    // 스택 위치 계산: 기존 알림들 아래에 쌓기
    const _recalcStack = () => {
        let topOffset = 20;
        $('.cat-notification.show').each(function() {
            $(this).css('top', topOffset + 'px');
            topOffset += $(this).outerHeight() + 8;
        });
    };
    
    requestAnimationFrame(() => { notifyHtml.addClass('show'); _recalcStack(); });

    if (type !== 'progress') {
        setTimeout(() => {
            notifyHtml.removeClass('show');
            setTimeout(() => { notifyHtml.remove(); _recalcStack(); }, 500);
        }, 2500);
    }
    return notifyHtml;
}

export function catNotifyProgress(message, onAbort) {
    const el = catNotify(message, 'progress');
    if (onAbort) {
        el.css({ cursor: 'pointer', pointerEvents: 'auto' });
        el.on('click', () => { onAbort(); el.removeClass('show'); setTimeout(() => el.remove(), 500); });
    }
    return el;
}

// 🚨 정밀 클리너: AI가 추가한 래핑만 제거, 원본 코드블록/YAML 보존!
export const CAT_BETA_VERSION = '1.4.1';
export const CAT_BUILD_CHANNEL = 'release';

export function cleanResult(text, originalText = null, structureProtection = null) {
    if (!text) return "";
    
    // 🚨 beta.3: CRLF/단독 CR 정규화 — 모델·프로필 경유 응답에 \r이 섞이면
    // 행 단위 정규식(구분선 카운트 등)이 통째로 미끄러진다. 모든 후처리의 관문에서 통일.
    // 🚨 beta.5: NFC 정규화 추가 — 모델이 자모 분해형(NFD)으로 한글을 뱉으면
    // ① 화면에서 받침이 분리되어 보이고(받침 무너짐 증상) ② 가-힣 정규식이
    // 전부 미끄러져 언어 감지/병기/말투 수집이 연쇄 오작동한다. 관문에서 통일.
    // 이미 NFC인 텍스트에는 무영향(멱등), CATFMT 토큰은 ASCII라 무영향.
    // AI가 앞에 붙이는 "번역:" 등 접두어 제거
    let cleaned = String(text).normalize('NFC').replace(/\r\n?/g, '\n');
    const responsePrefix = /^(번역|Translation|Output|Input|Result):\s*/i;
    if (!originalText || !responsePrefix.test(originalText.trimStart())) {
        cleaned = cleaned.replace(responsePrefix, "");
    }
    
    // 🚨 추론/사고 과정 텍스트 자동 제거 (Gemini Pro 모델이 종종 출력)
    // 영어 추론 단락만 정확히 제거 (한국어가 시작되는 지점까지만)
    // 핵심 마커: "Let's break down", "I have completed", "I will now proceed" 등
    const reasoningStartMarkers = /^(Let'?s break down|I have completed|I will now proceed|I have identified|Based on the directives|Let me translate|I do not need further|Looking at the (text|source|context)|Analyzing the (text|source|context)|First, let me|To translate this|Here is my analysis)/i;
    
    if (reasoningStartMarkers.test(cleaned)) {
        // 추론 시작 → 한국어/일본어/중국어가 시작되는 첫 위치까지 잘라냄
        const targetLangMatch = cleaned.match(/[\u3131-\uD79D\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/);
        if (targetLangMatch) {
            const targetIdx = targetLangMatch.index;
            // 추론 단락이 한국어 시작 직전까지만 차지하는지 검증
            // (영어가 50자 이상 + 한국어 시작 → 추론 제거)
            const beforeTarget = cleaned.substring(0, targetIdx);
            if (beforeTarget.length > 30 && /[a-zA-Z]/.test(beforeTarget)) {
                cleaned = cleaned.substring(targetIdx);
                console.log('[CAT] 🧹 추론 텍스트 제거됨');
            }
        }
    }
    cleaned = cleaned.trim();
    
    // AI가 응답 전체를 코드블록으로 감싼 경우만 벗기기
    const wholeCodeBlockMatch = cleaned.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/i);
    const originalHasCodeFence = originalText && /```/.test(originalText);
    const wrapperContainsProtectedToken = wholeCodeBlockMatch &&
        hasProtectedMarkerVariant(wholeCodeBlockMatch[1], structureProtection);
    if (wholeCodeBlockMatch && (!originalHasCodeFence || wrapperContainsProtectedToken)) {
        const inner = wholeCodeBlockMatch[1];
        if (!inner.includes('```')) {
            cleaned = inner;
            if (wrapperContainsProtectedToken) {
                console.log('[CAT] 🧹 모델이 응답 전체에 추가한 코드펜스 제거');
            }
        }
    }
    
    // 🚨 AI 거부/오류 응답 감지 (도구 거부, 검색 강제, 정책 거부 등)
    if (originalText) {
        const refusalPatterns = [
            /Google 검색을 수행해야|구글 검색을 수행해야/i,
            /도구 사용을 강제하는|도구를 사용해야/i,
            /이 작업을 수행할 수 없습니다|작업을 수행할 수 없어요|작업을 수행하기 어렵/i,
            /I (cannot|can'?t|am unable to) (perform|complete|fulfill|do|process) (this|that)/i,
            /I (need|must|have) to (search|use) (Google|the web|a tool)/i,
            /I'?m unable to (assist|help) with/i,
            /I cannot provide|I can'?t provide/i,
            /violates? (my|the|content) (guidelines|policy|policies)/i,
            /죄송하지만.*수행할 수 없|죄송합니다.*도와드릴 수 없/i,
            /사용자 사양을 준수하면서/i,
        ];
        // 거부 패턴이 본문 시작 100자 안에 있으면 거부 응답으로 판정
        const startSegment = cleaned.substring(0, 200);
        for (const pattern of refusalPatterns) {
            if (pattern.test(startSegment)) {
                console.warn('[CAT] 🚨 AI 거부 응답 감지. 결과 폐기 → 재번역 필요.');
                return "";
            }
        }
    }
    
    // 🚨 AI 생성모드 감지: 번역이 아닌 RP 이어쓰기/시스템 프롬프트 번역 방지
    if (originalText) {
        const ratio = cleaned.length / originalText.length;
        // 비율 3배 초과 + 시스템 프롬프트 패턴 감지 → 오염된 결과
        const systemPatterns = /\[ABSOLUTE DIRECTIVE|\[SYSTEM|\[OOC|\[IMPORTANT|DO NOT narrate|DO NOT summarize|DO NOT break|Write the full simulation|as an unbroken narrative|maintaining their established voice/i;
        if (ratio > 3 && systemPatterns.test(cleaned)) {
            console.warn('[CAT] 🚨 AI 생성모드 감지: 시스템 프롬프트 오염. 결과 폐기.');
            return "";
        }
        // 비율 4배 초과 → 이어쓰기 의심
        if (ratio > 4) {
            console.warn(`[CAT] ⚠️ 번역 결과 비정상 길이 (${ratio.toFixed(1)}배). 원문 기준 잘라냄.`);
            const cutPoint = originalText.length * 3;
            cleaned = cleaned.substring(0, cutPoint);
            const lastSentence = cleaned.match(/.*[.!?。！？」』\])\n]/s);
            if (lastSentence) cleaned = lastSentence[0];
        }
        // 🚨 번역 잘림 감지: 결과가 원문 대비 너무 짧으면 경고
        if (ratio < 0.3 && originalText.length > 200) {
            console.warn(`[CAT] ⚠️ 번역 결과가 짧음 (${(ratio * 100).toFixed(0)}%). 잘렸을 수 있음.`);
        }
    }
    
    // 줄바꿈 정리 (원본 구조 보존하면서)
    cleaned = cleaned.replace(/\r\n/g, "\n");
    
    // 🚨 문단 구조 보존: 원문과 비교해서 문단 수 부족하면 경고
    const originalHasLockedStructure = originalText &&
        (/```/.test(originalText) || /<\/?[a-zA-Z][^>]*>/.test(originalText) || dividerLineRegex('m').test(originalText));
    if (originalText && originalText.length > 200 && !originalHasLockedStructure) {
        const origParagraphs = originalText.split(/\n{2,}/).filter(p => p.trim().length > 0);
        const transParagraphs = cleaned.split(/\n{2,}/).filter(p => p.trim().length > 0);
        
        // 원문 3문단 이상인데 번역이 1문단으로 합쳐졌으면 명확한 실패
        if (origParagraphs.length >= 3 && transParagraphs.length === 1) {
            console.warn(`[CAT] ⚠️ 문단 구조 파괴: 원문 ${origParagraphs.length}문단 → 번역 1문단`);
            
            // 자동 복구 시도: 문장 끝 패턴 (.!? + 다음 대문자/대사)로 분할 후 원문 비율 맞춤
            cleaned = restoreParagraphStructure(cleaned, origParagraphs.length);
        } else if (origParagraphs.length >= 3 && transParagraphs.length < origParagraphs.length * 0.5) {
            console.warn(`[CAT] ⚠️ 문단 수 부족: 원문 ${origParagraphs.length}문단 → 번역 ${transParagraphs.length}문단`);
        }
    }
    
    // 🚨 따옴표 균형 검사 및 자동 복구
    cleaned = balanceQuotes(cleaned, originalText);
    
    return cleaned.trim();
}

// 한국어에서는 목적격·소유격·주격 대명사가 문맥상 자연스럽게 생략될 수 있다.
// {{obj}}/{{poss}}/{{subj}}는 정체성 매크로가 아니라 문법 슬롯이므로, 한국어
// 번역에서만 소프트 생략을 허용한다. {{user}}/{{char}}/{{User}} 등 실제 엔티티와
// 태그·펜스·코드행은 계속 하드 구조로 취급한다.
export function isKoreanGrammarMacro(value) {
    const match = String(value || '').match(/^\{\{\s*([^{}:\s]+)(?:::[\s\S]*)?\s*\}\}$/);
    return !!match && /^(?:obj|poss|subj)$/i.test(match[1]);
}

function classifyProtectedToken(value, type) {
    const raw = String(value ?? '');
    const macro = /^\{\{[\s\S]*?\}\}$/.test(raw);
    if (macro) {
        const allowKoreanOmission = isKoreanGrammarMacro(raw);
        return {
            role: allowKoreanOmission ? 'grammar_macro' : 'identity_macro',
            required: !allowKoreanOmission,
            hardStructure: false,
            allowKoreanOmission
        };
    }
    return {
        role: 'hard_structure',
        required: true,
        hardStructure: true,
        allowKoreanOmission: false
    };
}

function isMacroToken(token) {
    return token?.role === 'grammar_macro' || token?.role === 'identity_macro' ||
        /^\{\{[\s\S]*?\}\}$/.test(String(token?.value || ''));
}

function canOmitProtectedToken(token, options = {}) {
    return options.allowKoreanGrammarMacroOmission === true &&
        token?.allowKoreanOmission === true;
}

// 번역 대상의 구조 문법은 토큰으로 잠그고, 사람에게 읽히는 내용만 모델에 노출한다.
// 하드 구조가 누락되거나 순서를 바꾸면 복원 단계에서 결과를 거부한다.
export function protectTranslationStructure(text, options = {}) {
    const source = String(text || '').replace(/\r\n/g, '\n');
    let namespace = 'CATFMT';
    while (source.includes(`@@${namespace}_`)) namespace += 'X';
    
    const tokens = [];
    const addToken = (value, type) => {
        const marker = `@@${namespace}_${String(tokens.length).padStart(4, '0')}@@`;
        tokens.push({ marker, value, type, ...classifyProtectedToken(value, type) });
        return marker;
    };
    
    // 병기 모드의 실제 대사마다 빈 하드 앵커를 따옴표 안쪽에 삽입한다.
    // 모델은 내용은 번역하되 서로 다른 대사 슬롯을 합치거나 쪼갤 수 없다.
    let protectedText = source;
    const dialogueRanges = Array.isArray(options.dialogueRanges)
        ? options.dialogueRanges
            .filter(range => Number.isInteger(range?.index) && Number.isInteger(range?.contentLength))
            .sort((a, b) => a.index - b.index)
        : [];
    if (dialogueRanges.length > 0) {
        let cursor = 0;
        let anchored = '';
        for (const range of dialogueRanges) {
            const contentStart = range.index + 1;
            const contentEnd = contentStart + range.contentLength;
            const open = source[range.index];
            const close = source[contentEnd];
            const validQuotePair = (open === '"' && close === '"') ||
                (open === '“' && close === '”') ||
                (open === '「' && close === '」') ||
                (open === '『' && close === '』');
            // 범위는 보호기에 들어온 바로 그 문자열을 가리켜야 한다. 줄바꿈 정규화나
            // 전처리 불일치가 다시 생겨도 엉뚱한 서술 중간에는 절대 앵커를 넣지 않는다.
            if (range.index < cursor || contentStart > source.length ||
                contentEnd >= source.length || !validQuotePair) {
                continue;
            }
            anchored += source.slice(cursor, contentStart);
            anchored += addToken('', 'dialogue-open');
            anchored += source.slice(contentStart, contentEnd);
            anchored += addToken('', 'dialogue-close');
            cursor = contentEnd;
        }
        protectedText = anchored + source.slice(cursor);
    }

    // 실제 펜스를 숨겨 모델이 코드로 취급해 내부 번역을 건너뛰는 것을 막는다.
    protectedText = protectedText.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => {
        const firstBreak = block.indexOf('\n');
        const closeIndex = block.lastIndexOf('```');
        if (firstBreak < 0 || closeIndex <= firstBreak) return block;
        
        const opening = block.slice(0, firstBreak);
        const inner = block.slice(firstBreak + 1, closeIndex);
        const closing = block.slice(closeIndex);
        const protectedLines = inner.split('\n').map((line) => {
            const lineAnchor = addToken('', 'code-line');
            if (!line) return lineAnchor;
            
            const indent = line.match(/^[\t ]*/)?.[0] || '';
            const body = line.slice(indent.length);
            const indentToken = indent ? addToken(indent, 'indent') : '';
            
            if (isDividerElement(body)) {
                return lineAnchor + addToken(line, 'whole-line');
            }
            return lineAnchor + indentToken + body;
        }).join('\n');
        
        return `${addToken(opening, 'fence')}\n${protectedLines}${addToken(closing, 'fence')}`;
    });
    
    // 태그 속성, 매크로, 주석 경계는 번역시키지 않는다.
    protectedText = protectedText.replace(
        /<!--|-->|<\/?[a-zA-Z][^>]*>|\{\{[\s\S]*?\}\}/g,
        (value) => addToken(value, 'inline')
    );
    
    // 코드블럭 밖의 정규식 트리거용 구분선도 원문 그대로 보존한다.
    protectedText = protectedText.replace(
        dividerLineRegex('gm'),
        (value) => addToken(value, 'whole-line')
    );
    
    const expectedMarkers = tokens
        .map(token => ({ marker: token.marker, index: protectedText.indexOf(token.marker) }))
        .filter(item => item.index >= 0)
        .sort((a, b) => a.index - b.index)
        .map(item => item.marker);
    
    return {
        text: protectedText,
        source,
        namespace,
        tokens,
        expectedMarkers,
        // 🚨 beta.9: 마커 사이 구간별 텍스트 유무 패턴 — 복원 시 대조해 "블록 경계를 넘는 밀림" 감지
        segmentPattern: computeSegmentPattern(protectedText, expectedMarkers),
        hasStructure: expectedMarkers.length > 0
    };
}

// 🚨 beta.3 디버그: 렌더링으로는 구분 불가능한 특수 문장부호에 코드포인트를 병기
// (커리 아포스트로피 ’ vs ' 같은 한 글자 차이가 원격 로그에서 보이도록)
export function revealSpecialChars(value) {
    return String(value || '').replace(
        /[\u2018\u2019\u201C\u201D\u2010-\u2015\u2026\u00A0\u00AD\u3000\u2500-\u257F\u30FC\uFF0D\r]/g,
        (ch) => `${ch}⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`
    );
}

// 🚨 beta.3 디버그: 구분선 감사 — 엄격 매칭된 라인과 "구분선처럼 생겼는데 매칭 실패한"
// 라인(----아님, ─── 박스문자, em-dash 연타, 숨은 공백 등)을 문자코드 노출로 구분해 나열
export function auditDividerLines(text) {
    const strict = /^(?:[\t \u00A0]*)(?:-{3,}|_{3,}|\*{3,})(?:[\t \u00A0]*)$/;
    const loose = /^[\s\u00A0]*[-\u2010-\u2015\u2500-\u257F_*=~\u30FC\uFF0D]{2,}[\s\u00A0]*$|^.{0,3}[-_*]{3,}.{0,3}$/;
    const matched = [];
    const nearMiss = [];
    String(text || '').split('\n').forEach((line, idx) => {
        if (strict.test(line)) matched.push(`${idx + 1}행 ${JSON.stringify(revealSpecialChars(line))}`);
        else if (loose.test(line)) nearMiss.push(`${idx + 1}행 ${JSON.stringify(revealSpecialChars(line))}`);
    });
    return { matched, nearMiss };
}

// 🚨 beta.3 디버그: 특정 위치 앞뒤 문맥 발췌 (제어문자 가시화 포함)
function snippetAround(text, index, length, radius = 50) {
    const source = String(text || '');
    const start = Math.max(0, index - radius);
    const end = Math.min(source.length, index + length + radius);
    return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

// 🚨 beta.3: computeSegmentPattern과 동일한 순차 indexOf 워크로 i번째 구간의 실제 텍스트를 추출
// (구간 i = 마커 i-1 뒤 ~ 마커 i 앞. i=0은 첫 마커 앞, i=markers.length는 마지막 마커 뒤)
function getSegmentByMarkers(text, markers, targetIndex) {
    let rest = String(text || '');
    for (let i = 0; i < markers.length; i++) {
        const idx = rest.indexOf(markers[i]);
        if (idx < 0) return i === targetIndex ? rest : '';
        if (i === targetIndex) return rest.slice(0, idx);
        rest = rest.slice(idx + markers[i].length);
    }
    return targetIndex === markers.length ? rest : '';
}

// 🚨 beta.3: "직전 토큰에 공백 없이 붙은 짧은 한국어 꼬리"인지 판정 (조사+서술어 SOV 이동분)
// 첫 글자가 한글이어야 함 = 앞 토큰에 조사로 직결. 공백/줄바꿈으로 시작하면 진짜 밀림이므로 불허.
// 🚨 v1.1.4: 소유격 매크로 어순 재배치 공용 판정 코어 (A′ 구조).
// 세그먼트 검증과 레이아웃 검증이 같은 재배치를 각각 잡는 이중 구조라,
// 예외 정책을 이 한 곳에만 두고 양쪽 래퍼가 부품만 추출해 전달한다.
// 개행 함정: \s 금지, 수평 공백 [ \t]만 허용.
function isSafeLeadingPossessiveReorderParts({ sourceBefore, sourceAfter, outputBefore, outputAfter, structureValue, structureType }) {
    // 실제 {{macro}}만 허용 — fence/tag/comment/whole-line 거부
    if (structureType !== 'macro') return false;
    if (!/^\{\{[^{}\r\n]+\}\}$/.test(String(structureValue || ''))) return false;
    // 출력 선행 구간은 수평 공백만
    if (!/^[ \t]*$/.test(String(outputBefore || ''))) return false;
    const src0 = String(sourceBefore || '');
    // 원문 선행 구간: 개행/완결 문장 금지, 길이 제한
    if (/[\r\n]/.test(src0)) return false;
    if (src0.length > 160) return false;
    if (/[.!?]["'’)\]]*[ \t]+/.test(src0)) return false;
    // 소유격 지문: 원문 매크로 직후 's, 출력 매크로 직후 조사 '의'
    if (!/^[ \t]*['’]s\b/i.test(String(sourceAfter || ''))) return false;
    if (!/^의(?:[가-힣A-Za-z0-9]|[ \t])/.test(String(outputAfter || ''))) return false;
    return true;
}

// 세그먼트 검증용 래퍼: 첫 마커 앞뒤 구간 + 첫 토큰 정보 전달
function isSafeLeadingPossessiveMacroReorder(protection, output) {
    const markers = protection.expectedMarkers;
    if (!Array.isArray(markers) || markers.length < 1) return false;
    const firstToken = protection.tokens.find(token => token.marker === markers[0]);
    if (!firstToken) return false;
    const isMacro = firstToken.type === 'inline' && /^\{\{[^{}\r\n]+\}\}$/.test(firstToken.value);
    return isSafeLeadingPossessiveReorderParts({
        sourceBefore: getSegmentByMarkers(protection.text, markers, 0),
        sourceAfter: getSegmentByMarkers(protection.text, markers, 1),
        outputBefore: getSegmentByMarkers(output, markers, 0),
        outputAfter: getSegmentByMarkers(output, markers, 1),
        structureValue: firstToken.value,
        structureType: isMacro ? 'macro' : firstToken.type
    });
}

// 레이아웃 검증용 래퍼: 첫 region 앞뒤 구간 + region 값/종류 전달
// (캐시·fallback 경로는 세그먼트 검증 없이 validateTranslationStructure를 직접
//  호출하므로, 레이아웃 쪽에도 같은 코어를 적용해야 반쪽 수정이 되지 않는다)
function isSafeLeadingPossessiveLayoutReorder(source, output) {
    const srcRegions = getStructureMatches(String(source || ''));
    const outRegions = getStructureMatches(String(output || ''));
    if (!srcRegions.length || !outRegions.length) return false;
    const s0 = srcRegions[0], o0 = outRegions[0];
    // 양쪽 첫 요소가 같은 매크로여야 함
    if (s0.value !== o0.value) return false;
    const type = /^\{\{[\s\S]*\}\}$/.test(s0.value) ? 'macro'
        : s0.value.startsWith('```') ? 'fence' : 'tag';
    return isSafeLeadingPossessiveReorderParts({
        sourceBefore: String(source).slice(0, s0.index),
        sourceAfter: String(source).slice(s0.end),
        outputBefore: String(output).slice(0, o0.index),
        outputAfter: String(output).slice(o0.end),
        structureValue: s0.value,
        structureType: type
    });
}

function isKoreanTailSegment(segment) {
    return /^[가-힣][가-힣\s,.!?…~'’"”-]{0,39}$/.test(String(segment || ''));
}

// 마커 순서대로 텍스트를 잘라 각 구간에 실제 내용(문자·숫자)이 있는지 boolean 배열로
export function computeSegmentPattern(text, markers) {
    const pattern = [];
    let rest = String(text || '');
    for (const marker of markers) {
        const idx = rest.indexOf(marker);
        if (idx < 0) { pattern.push(/[가-힣a-zA-Z0-9]/.test(rest)); return pattern; }
        pattern.push(/[가-힣a-zA-Z0-9]/.test(rest.slice(0, idx)));
        rest = rest.slice(idx + marker.length);
    }
    pattern.push(/[가-힣a-zA-Z0-9]/.test(rest));
    return pattern;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createProtectedMarkerPattern(marker, flags = '') {
    const match = String(marker || '').match(/^@@(.+)_([0-9]{4})@@$/);
    if (!match) return new RegExp(escapeRegExp(marker), flags);
    
    const namespace = escapeRegExp(match[1]);
    const index = escapeRegExp(match[2]);
    return new RegExp(
        `\\\\?@\\s*\\\\?@\\s*${namespace}\\s*_\\s*${index}\\s*\\\\?@\\s*\\\\?@`,
        flags
    );
}

// 일부 모델은 @@CATFMT_0008@@를 @CATFMT_0008@, @0008@, 심하면 @8@로
// 줄여 출력한다. 번호만 남은 별칭은 일반 본문의 @숫자@와 충돌할 수 있으므로
// 현재 보호기에 실제로 존재하는 번호만 후보로 만들고, 원문에 같은 표기가 있으면
// 그 별칭은 복구하지 않는다.
function getProtectedMarkerAliases(marker) {
    const match = String(marker || '').match(/^@@.+_([0-9]{4})@@$/);
    if (!match) return [];
    const padded = match[1];
    const compact = String(Number.parseInt(padded, 10));
    return [marker.slice(1, -1), ...new Set([padded, compact])].map(value =>
        value.startsWith('@') ? value : `@${value}@`
    );
}

function protectedTokenLeakPattern(flags = 'g') {
    return new RegExp(
        '@@[A-Za-z][A-Za-z0-9_]*_\\d{4}@@' +
        '|@[A-Za-z][A-Za-z0-9_]*_\\d{4}@' +
        '|@@\\d{1,4}@@' +
        '|@\\d{1,4}@',
        flags
    );
}

function countProtectedLikeSourceLiterals(protection) {
    const counts = new Map();
    for (const match of String(protection?.source || '').matchAll(protectedTokenLeakPattern('gi'))) {
        const key = match[0].toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

function findUnexpectedProtectedTokenAliases(text, protection) {
    if (!protection?.hasStructure) return [];
    const allowedSource = countProtectedLikeSourceLiterals(protection);
    const expected = new Set((protection.expectedMarkers || []).map(marker => marker.toLowerCase()));
    const unexpected = [];
    for (const match of String(text || '').matchAll(protectedTokenLeakPattern('gi'))) {
        const key = match[0].toLowerCase();
        if (expected.has(key)) continue;
        const remaining = allowedSource.get(key) || 0;
        if (remaining > 0) {
            allowedSource.set(key, remaining - 1);
        } else {
            unexpected.push(match[0]);
        }
    }
    return unexpected;
}

function hasProtectedMarkerVariant(text, protection) {
    if (!protection?.expectedMarkers?.length) return false;
    const source = String(text || '');
    return protection.expectedMarkers.some(marker => {
        if (createProtectedMarkerPattern(marker, 'i').test(source)) return true;
        return getProtectedMarkerAliases(marker).some(alias =>
            !String(protection.source || '').includes(alias) && source.includes(alias)
        );
    });
}

function normalizeProtectedStructureResponse(text, protection) {
    if (!protection?.hasStructure) return String(text || '');
    
    let normalized = String(text || '');
    // 정확한 정식 마커는 먼저 사설 슬롯으로 치워 둔다. @CATFMT_0000@가
    // @@CATFMT_0000@@의 내부 부분 문자열이므로 바로 치환하면 정상 마커까지
    // 세 겹 @로 부풀 수 있고, 연속 축약 토큰(@1@@2@)도 경계 정규식으로는
    // 서로의 @를 먹을 수 있다. 슬롯 치환은 두 경우를 모두 결정론적으로 피한다.
    const markerSlots = new Map();
    protection.expectedMarkers.forEach((marker, index) => {
        const slot = `\uE000CATFMT${index}\uE001`;
        markerSlots.set(marker, slot);
        normalized = normalized.split(marker).join(slot);
    });
    for (const marker of protection.expectedMarkers) {
        const slot = markerSlots.get(marker);
        for (const alias of getProtectedMarkerAliases(marker)) {
            if (!String(protection.source || '').includes(alias)) {
                normalized = normalized.split(alias).join(slot);
            }
        }
        normalized = normalized.replace(createProtectedMarkerPattern(marker, 'gi'), slot);
    }
    for (const marker of protection.expectedMarkers) {
        normalized = normalized.split(markerSlots.get(marker)).join(marker);
        const escapedMarker = escapeRegExp(marker);
        const wrappers = [
            new RegExp('`{1,3}[\\t ]*' + escapedMarker + '[\\t ]*`{1,3}', 'g'),
            new RegExp('\\*\\*[\\t ]*' + escapedMarker + '[\\t ]*\\*\\*', 'g'),
            new RegExp('__[\\t ]*' + escapedMarker + '[\\t ]*__', 'g'),
            new RegExp('<code>[\\t ]*' + escapedMarker + '[\\t ]*</code>', 'gi')
        ];
        for (const wrapper of wrappers) {
            normalized = normalized.replace(wrapper, marker);
        }
    }
    
    // 모델이 구조 토큰 사이에 공백/개행만 덧붙인 경우 원래 간격으로 되돌린다.
    // 번역 텍스트가 끼어 있으면 손대지 않아 누락이나 재배치를 숨기지 않는다.
    for (let i = 0; i < protection.expectedMarkers.length - 1; i++) {
        const current = protection.expectedMarkers[i];
        const next = protection.expectedMarkers[i + 1];
        const sourceCurrent = protection.text.indexOf(current);
        const sourceNext = protection.text.indexOf(next, sourceCurrent + current.length);
        if (sourceCurrent < 0 || sourceNext < 0) continue;
        
        const sourceGap = protection.text.slice(sourceCurrent + current.length, sourceNext);
        if (!/^\s*$/.test(sourceGap)) continue;
        
        const currentIndex = normalized.indexOf(current);
        const nextIndex = normalized.indexOf(next, currentIndex + current.length);
        if (currentIndex < 0 || nextIndex < 0) continue;
        if (normalized.indexOf(current, currentIndex + current.length) >= 0 ||
            normalized.indexOf(next, nextIndex + next.length) >= 0) {
            continue;
        }
        
        const outputGap = normalized.slice(currentIndex + current.length, nextIndex);
        if (!/^\s*$/.test(outputGap) || outputGap === sourceGap) continue;
        normalized = normalized.slice(0, currentIndex + current.length) +
            sourceGap +
            normalized.slice(nextIndex);
    }
    
    return normalized;
}

// 최종 fail-open 표시에서도 변형된 내부 토큰이 사용자에게 노출되지 않도록,
// 현재 요청에서 알고 있는 토큰 별칭만 원래 HTML/CSS/펜스/매크로 값으로 복원한다.
export function restoreProtectedTokenLeaks(text, protection) {
    if (!protection?.hasStructure) return String(text || '');
    let restored = normalizeProtectedStructureResponse(text, protection);
    for (const token of protection.tokens || []) {
        restored = restored.split(token.marker).join(token.value);
    }
    return restored;
}

// 최종 표시용: 알려진 토큰은 원래 구조로 복원하고, 모델이 번호/이름까지
// 바꿔 버려 복원 근거가 없는 토큰형 문자열은 제거한다. 단 원문에 실제로 있던
// @0@ 같은 리터럴은 등장 횟수만큼 그대로 남긴다.
export function sanitizeProtectedTokenLeaks(text, protection) {
    const restored = restoreProtectedTokenLeaks(text, protection);
    if (!protection?.hasStructure) {
        return restored.replace(/@@[A-Za-z][A-Za-z0-9_]*_\d{4}@@/g, '');
    }
    const allowedSource = countProtectedLikeSourceLiterals(protection);
    return restored.replace(protectedTokenLeakPattern('gi'), (token) => {
        const key = token.toLowerCase();
        const remaining = allowedSource.get(key) || 0;
        if (remaining > 0) {
            allowedSource.set(key, remaining - 1);
            return token;
        }
        return '';
    });
}

function collapseBilingualMacroCopiesInQuote(content) {
    const bilingual = String(content || '').match(/^([\s\S]*?)\s+\[([\s\S]*)\]\s*$/);
    if (!bilingual) return content;

    const originalPart = bilingual[1];
    const translationPart = bilingual[2];
    if (!/[가-힣]/.test(translationPart)) return content;
    const copyPattern = /\{\{[\s\S]*?\}\}|@@[A-Za-z0-9_]+_\d{4}@@/g;
    // 🚨 beta.3: 병기 복사본 대조를 소문자 키로 — 원문 {{User}} / 번역 파트 {{user}}처럼
    // 대소문자만 다르게 복사돼도 같은 매크로의 복사본으로 인정 (구조 토큰은 고정 표기라 무영향)
    const availableCopies = new Map();
    for (const match of originalPart.matchAll(copyPattern)) {
        const key = match[0].toLowerCase();
        availableCopies.set(key, (availableCopies.get(key) || 0) + 1);
    }
    if (availableCopies.size === 0) return content;

    let collapsedCopies = 0;
    const unmatchedTranslation = translationPart.replace(copyPattern, (token) => {
        const key = token.toLowerCase();
        const remaining = availableCopies.get(key) || 0;
        if (remaining < 1) return token;
        availableCopies.set(key, remaining - 1);
        collapsedCopies++;
        return '';
    });
    if (collapsedCopies === 0) return content;

    // 비교용 문자열에서 병기 번역문 자체는 제외하되, 허용 대상이 아닌 구조 요소는
    // 남겨서 실제 태그/매크로 추가나 중복이 검증을 우회하지 못하게 한다.
    const residualStructure = unmatchedTranslation.match(
        /```[^\n]*|<!--|-->|<\/?[a-zA-Z][^>]*>|\{\{[\s\S]*?\}\}|@@[A-Za-z0-9_]+_\d{4}@@/g
    ) || [];
    return originalPart + residualStructure.join('');
}

// 한영병기 대사 안에서 동일 매크로가 영어 원문과 한국어 번역에 한 번씩 필요한
// 경우만 구조 비교상 하나로 센다. 실제 출력은 변경하지 않는다.
export function normalizeBilingualMacroCopiesForValidation(text) {
    const normalizeQuotes = (segment) => {
        let normalized = segment;
        const quotePatterns = [
            // 🚨 beta.7: 개행 금지 — 따옴표 어긋남이 문단을 걸치는 오탐 차단
            { regex: /"([^"\n]*)"/g, open: '"', close: '"' },
            { regex: /“([^”\n]*)”/g, open: '“', close: '”' },
            { regex: /「([^」\n]*)」/g, open: '「', close: '」' },
            { regex: /『([^』\n]*)』/g, open: '『', close: '』' }
        ];
        for (const { regex, open, close } of quotePatterns) {
            normalized = normalized.replace(
                regex,
                (match, content) => open + collapseBilingualMacroCopiesInQuote(content) + close
            );
        }
        return normalized;
    };

    // 🚨 beta.3: 검증용 사본에서만 커리 따옴표를 스트레이트로 통일한다.
    // 작가/모델이 “…" 처럼 짝을 섞으면 스트레이트 홀짝이 밀려 뒤쪽 병기 인용구가
    // 인용구로 인식되지 않고 → 매크로 collapse 미실행 → 토큰 중복 오탐이 남.
    // (이 함수의 반환값은 검증 비교에만 쓰이고 실제 출력은 바꾸지 않음)
    const source = String(text || '').replace(/[“”]/g, '"');
    const tagPattern = /<\/?[a-zA-Z][^>]*>/g;
    let normalized = '';
    let lastIndex = 0;
    for (const tag of source.matchAll(tagPattern)) {
        normalized += normalizeQuotes(source.slice(lastIndex, tag.index));
        normalized += tag[0];
        lastIndex = tag.index + tag[0].length;
    }
    normalized += normalizeQuotes(source.slice(lastIndex));
    return normalized;
}

export function restoreTranslationStructure(text, protection, options = {}) {
    if (!protection?.hasStructure) {
        return { ok: true, text: String(text || ''), reason: null };
    }
    
    const rawOutput = String(text || '');
    let output = normalizeProtectedStructureResponse(rawOutput, protection);
    const unexpectedAliases = findUnexpectedProtectedTokenAliases(output, protection);
    if (unexpectedAliases.length > 0) {
        return {
            ok: false,
            text: null,
            code: 'VALIDATION_TOKEN_ALIAS_UNKNOWN',
            reason: `알 수 없는 구조 토큰 변형: ${[...new Set(unexpectedAliases)].join(', ')}`
        };
    }
    const tokenByMarker = new Map((protection.tokens || []).map(token => [token.marker, token]));
    // 🚨 v1.1.4-beta.6 (J): 인접 이중 마커 삼킴 자동 구제.
    // 들여쓰기 리스트/상태창을 보호하면 @@CATFMT_0018@@@@CATFMT_0019@@처럼
    // 마커가 딱 붙은 쌍이 생기는데(들여쓰기 토큰+내용 토큰), LLM이 이런 연속
    // 토큰을 하나로 병합하는 실수가 실측 재현됨 → 같은 원문이면 결정론적으로
    // 반복 실패("특정 메시지만 계속 안 됨" 제보의 유력 원인).
    // 구제 조건(전부 충족 시에만): ① 마커가 출력에 없음 ② 보호 원문에서 그 마커가
    // 다른 마커와 즉시 인접 ③ 그 파트너가 출력에 정확히 1회 존재.
    // 재삽입 위치는 원문과 동일한 쪽(파트너의 앞/뒤)이므로 순서가 보존된다.
    for (const marker of protection.expectedMarkers) {
        if (output.includes(marker)) continue;
        // 한국어 문법 슬롯은 실제 생략일 수 있다. 하드 구조용 인접 마커 구제 로직이
        // 이를 되살려 부자연스러운 매크로를 강제로 삽입하지 않게 먼저 제외한다.
        if (canOmitProtectedToken(tokenByMarker.get(marker), options)) continue;
        const before = protection.text.match(new RegExp(`(@@CATFMT_\\d{4}@@)${marker}`));
        const after = protection.text.match(new RegExp(`${marker}(@@CATFMT_\\d{4}@@)`));
        const partnerBefore = before ? before[1] : null;   // 원문에서 marker 바로 앞에 붙은 마커
        const partnerAfter = after ? after[1] : null;      // 원문에서 marker 바로 뒤에 붙은 마커
        const countIn = (hay, needle) => hay.split(needle).length - 1;
        if (partnerBefore && countIn(output, partnerBefore) === 1) {
            output = output.replace(partnerBefore, partnerBefore + marker);
            console.log(`[CAT] 🔧 인접 마커 삼킴 구제: ${marker} (${partnerBefore} 뒤에 재삽입)`);
        } else if (partnerAfter && countIn(output, partnerAfter) === 1) {
            output = output.replace(partnerAfter, marker + partnerAfter);
            console.log(`[CAT] 🔧 인접 마커 삼킴 구제: ${marker} (${partnerAfter} 앞에 재삽입)`);
        }
    }
    const allowBilingualMacroCopies = options.allowBilingualMacroCopies === true;
    const validationOutput = allowBilingualMacroCopies
        ? normalizeBilingualMacroCopiesForValidation(output)
        : output;
    if (output !== rawOutput) {
        console.log('[CAT] 🔧 모델별 구조 토큰 표기 차이 자동 복구');
    }
    let previousIndex = -1;
    // 🚨 v1.1.12 (R): 문단 내 inline 토큰(매크로류) 어순 재배열 허용 판정.
    // 한국어 통사론상 종속절("~할 때까지", "~하려고")은 본동사 앞으로 와야 해서,
    // "until {{d}} fixes it" 류 문장은 원문 토큰 순서로는 한국어가 성립 불가 —
    // 자연스러운 번역일수록 '구조 토큰 순서 변경'으로 거부되던 사고가 실측 로그로
    // 확인됨(1.1.11, 0002↔0003 / 0018↔0019 이중 스왑, 재시도 결정론 실패).
    // 허용 조건(전부 충족 시에만): ① 모든 마커가 정확히 1회씩 존재
    // ② 원문/출력의 문단(빈 줄 경계) 수가 동일 ③ 각 문단의 마커 '집합'이 동일
    //   (= 문단 경계를 넘는 이동 없음 — 진짜 사고인 블록 밀림은 계속 차단)
    // ④ inline 외 타입(펜스·코드행·들여쓰기·통행) 토큰의 상대 순서는 불변.
    // 🚨 v1.2.0 (역할 분리 — 단일 진실 공급원): 매크로는 '번역 금지 placeholder'이지
    // 구조 경계가 아니다. 아래 8층 검증 전부가 이 집합 하나를 공유한다.
    const _macroMarkers = new Set(protection.tokens
        .filter(isMacroToken)
        .map(t => t.marker));
    const _softOmittableMarkers = new Set(protection.tokens
        .filter(token => canOmitProtectedToken(token, options))
        .map(token => token.marker));
    const reorderExemption = (() => {
        const markersIn = txt => (String(txt).match(/@@CATFMT_\d{4}@@/g) || []);
        const allOnce = protection.expectedMarkers.every(m =>
            validationOutput.split(m).length - 1 === 1);
        if (!allOnce) return false;
        const srcParas = protection.text.split(/\n[ \t]*\n/);
        const outParas = validationOutput.split(/\n[ \t]*\n/);
        if (srcParas.length !== outParas.length) return false;
        for (let i = 0; i < srcParas.length; i++) {
            const a = markersIn(srcParas[i]).slice().sort().join('|');
            const b = markersIn(outParas[i]).slice().sort().join('|');
            if (a !== b) return false;
        }
        // v1.2.0: 순서 불변 요구를 '비매크로 전체'(태그 포함)로 — 태그 재배열은
        // R 사면 대상에서 제외 (매트릭스: 태그 순서 변경은 거부해야 하는 손상)
        const seq = txt => markersIn(txt).filter(m => !_macroMarkers.has(m)).join('|');
        if (seq(protection.text) !== seq(validationOutput)) return false;
        return true;
    })();
    // 사면은 '실제 위반을 면제한 경우'에만 발효 — 정상 출력에서 구간 검사(beta.9)가
    // 광역으로 꺼지는 것을 방지 (reorderExemption은 '가능 여부', reorderExcused는 '발동 여부')
    let reorderExcused = false;
    for (const marker of protection.expectedMarkers) {
        const firstIndex = validationOutput.indexOf(marker);
        if (firstIndex < 0) {
            if (_softOmittableMarkers.has(marker)) {
                const token = tokenByMarker.get(marker);
                console.warn(`[CAT] 🪶 한국어 문법 매크로 생략 허용: ${token?.value || marker}`);
                continue;
            }
            const sourcePos = protection.text.indexOf(marker);
            return {
                ok: false, text: null, code: 'VALIDATION_TOKEN_MISSING_HARD', reason: `구조 토큰 누락: ${marker}`,
                detail: `원문에서 이 토큰의 자리:\n${snippetAround(protection.text, sourcePos, marker.length)}`
            };
        }
        const secondIndex = validationOutput.indexOf(marker, firstIndex + marker.length);
        if (secondIndex >= 0 && _macroMarkers.has(marker)) {
            // 🚨 v1.2.0: 매크로 복제 허용 — 원문에 있던 placeholder의 재사용은
            // 복원 시 정당한 이름 재호출이 된다 (한국어의 대명사 회피 습관)
            console.log(`[CAT] 🐾 매크로 복제 허용: ${marker}`);
        } else if (secondIndex >= 0) {
            return {
                ok: false, text: null, code: 'VALIDATION_TOKEN_DUPLICATED_HARD', reason: `구조 토큰 중복: ${marker}`,
                detail: `1번째 등장:\n${snippetAround(validationOutput, firstIndex, marker.length)}\n\n2번째 등장:\n${snippetAround(validationOutput, secondIndex, marker.length)}`
            };
        }
        if (_macroMarkers.has(marker)) {
            // 🚨 v1.2.0: 매크로는 순서 검사 자체에서 제외 (previousIndex 진행에도 불참)
        } else if (firstIndex <= previousIndex && reorderExemption) {
            if (!reorderExcused) console.log('[CAT] 🔀 문단 내 inline 토큰 어순 재배열 허용 (한국어 통사 재배치)');
            reorderExcused = true;
            previousIndex = firstIndex;
        } else if (firstIndex <= previousIndex) {
            return {
                ok: false, text: null, reason: `구조 토큰 순서 변경: ${marker}`,
                detail: `출력에서의 위치:\n${snippetAround(validationOutput, firstIndex, marker.length)}`
            };
        } else {
            previousIndex = firstIndex;
        }
    }
    
    const markerPattern = new RegExp(`@@${protection.namespace}_\\d{4}@@`, 'g');
    const outputMarkers = validationOutput.match(markerPattern) || [];
    const _expectedSet = new Set(protection.expectedMarkers);
    if (outputMarkers.some(m => !_expectedSet.has(m))) {
        return { ok: false, text: null, code: 'VALIDATION_TOKEN_UNKNOWN', reason: '알 수 없는 구조 토큰이 추가되었거나 삭제됨' };
    }
    // 🚨 v1.2.0: 총수 검사는 하드 토큰만 — 매크로 복제로 총수가 늘어도 정당
    const _hardOut = outputMarkers.filter(m => !_macroMarkers.has(m)).length;
    const _hardExp = protection.expectedMarkers.filter(m => !_macroMarkers.has(m)).length;
    if (_hardOut !== _hardExp) {
        return { ok: false, text: null, code: 'VALIDATION_TOKEN_COUNT_HARD', reason: '알 수 없는 구조 토큰이 추가되었거나 삭제됨' };
    }
    
    // 🚨 beta.9: 세그먼트 패턴 대조 — 마커 순서가 맞아도 텍스트가 블록 경계를 넘어
    // 이동하면(예: 상태창 앞 대사가 상태창 뒤로 밀림) 원문에서 비어있던 구간에
    // 내용이 생기거나 내용 있던 구간이 비게 됨 → 밀림으로 판정해 거부 (재시도 유도)
    // 🚨 v1.1.12 (R): 문단 내 재배열 면제 시 구간 패턴 대조 생략 — 문단 집합
    // 동일성 검사가 이미 블록 밀림을 차단하며, 재배열은 구간 유무 패턴을 정당하게 바꿈.
    const _hardMarkers = protection.expectedMarkers.filter(m => !_macroMarkers.has(m));
    if (!reorderExcused && Array.isArray(protection.segmentPattern) && _hardMarkers.length > 0) {
        // 🚨 v1.2.0: 블록 경계는 하드 토큰만 — 매크로를 뺀 패턴으로 양측 재계산
        const srcPatternHard = computeSegmentPattern(protection.text, _hardMarkers);
        const outPattern = computeSegmentPattern(validationOutput, _hardMarkers);
        for (let i = 0; i < srcPatternHard.length; i++) {
            if (srcPatternHard[i] !== outPattern[i]) {
                // 🚨 beta.3: 한국어 SOV 어순 재배치 허용 — 원문이 토큰으로 문장을 끝내면
                // (he spots {{user}}.) 한국어 번역은 조사+서술어가 토큰 뒤로 이동함
                // ({{user}}를 발견했다.) → 빈 구간 침입이 "직전 토큰에 공백 없이 붙은
                // 짧은 한국어 꼬리"뿐이면 블록 밀림이 아니므로 통과시킨다.
                if (!srcPatternHard[i] && outPattern[i] && i > 0 &&
                    isKoreanTailSegment(getSegmentByMarkers(validationOutput, _hardMarkers, i))) {
                    continue;
                }
                // 🚨 v1.1.4: 첫 구간 소유격 매크로 어순 재배치 (원문 있음→출력 빈 구간, i===0)
                if (i === 0 && srcPatternHard[0] && !outPattern[0] &&
                    isSafeLeadingPossessiveMacroReorder(protection, validationOutput)) {
                    continue;
                }
                const kind = srcPatternHard[i] ? '구간 내용 소실' : '빈 구간에 텍스트 침입';
                const srcSeg = getSegmentByMarkers(protection.text, _hardMarkers, i);
                const outSeg = getSegmentByMarkers(validationOutput, _hardMarkers, i);
                return {
                    ok: false, text: null,
                    reason: `텍스트가 블록 경계를 넘어 이동함 (${kind}, 구간 ${i})`,
                    detail: `원문 구간 ${i}: ${JSON.stringify(revealSpecialChars(srcSeg).slice(0, 160))}\n출력 구간 ${i}: ${JSON.stringify(revealSpecialChars(outSeg).slice(0, 160))}`
                };
            }
        }
    }
    
    let restored = output;
    // 한국어에서는 {{obj}}/{{poss}}/{{subj}}가 조사와 함께 쓰이지 않으면 생략 가능하다.
    // 모델이 이를 이미 완결된 서술어 뒤·문장부호 앞에 고립시키면(…했다{{poss}}.)
    // 보존할 문법 기능이 없으므로 복원 전에 해당 소프트 슬롯만 제거한다.
    for (const token of protection.tokens) {
        if (!canOmitProtectedToken(token, options)) continue;
        const escaped = escapeRegExp(token.marker);
        const stranded = new RegExp(`${escaped}(?=\\s*(?:[.!?…,;:)}\\]"'»]|$))`, 'g');
        const cleaned = restored.replace(stranded, '');
        if (cleaned !== restored) {
            console.log(`[CAT] 🪶 문장 끝 고립 문법 매크로 제거: ${token.value}`);
            restored = cleaned;
        }
    }
    for (const token of protection.tokens) {
        // 🚨 v1.2.0: 전체 치환 — 매크로 복제 허용에 따라 모든 등장을 복원
        restored = restored.split(token.marker).join(token.value);
    }
    // 🚨 v1.2.0: 복원 후 미해결 보호 토큰 잔존 검사 (매트릭스 필수 거부)
    markerPattern.lastIndex = 0;
    if (markerPattern.test(restored)) {
        markerPattern.lastIndex = 0;
        return { ok: false, text: null, reason: '복원 후 미해결 보호 토큰 잔존' };
    }
    markerPattern.lastIndex = 0;

    const validation = validateTranslationStructure(protection.source, restored,
        reorderExcused ? { ...options, allowInlineMacroReorder: true } : options);
    if (validation.repairedKeys > 0) {
        console.log(`[CAT] 🔧 구조 키 ${validation.repairedKeys}개 자동 복원`);
    }
    if (!validation.ok) {
        return { ok: false, text: null, reason: validation.reason };
    }
    return {
        ok: true,
        text: validation.text,
        reason: null,
        boundaryRecovery: validation.boundaryRecovery || null,
        softNote: validation.softNote || null
    };
}

export function restoreTranslationTokens(text, protection) {
    if (!protection?.hasStructure) {
        return { ok: true, text: String(text || ''), reason: null };
    }
    
    let restored = normalizeProtectedStructureResponse(text, protection);
    const unexpectedAliases = findUnexpectedProtectedTokenAliases(restored, protection);
    if (unexpectedAliases.length > 0) {
        return {
            ok: false,
            text: null,
            reason: `직역 파트에 알 수 없는 구조 토큰 변형이 남음: ${[...new Set(unexpectedAliases)].join(', ')}`
        };
    }
    for (const token of protection.tokens) {
        restored = restored.split(token.marker).join(token.value);
    }
    
    const unresolvedMatches = restored.match(new RegExp(`@@${protection.namespace}_\\d{4}@@`, 'g'));
    if (unresolvedMatches) {
        return {
            ok: false, text: null, reason: '직역 파트에 복원되지 않은 구조 토큰이 남음',
            detail: `잔존 토큰: ${[...new Set(unresolvedMatches)].join(', ')}`
        };
    }
    return { ok: true, text: restored, reason: null };
}

// 🚨 beta.3: 모델이 매크로 대소문자만 통일한 경우({{User}}→{{user}}) 원문 표기로 복원.
// 원문 자체가 {{user}}/{{User}} 혼용일 수 있으므로 등장 순서 기준으로 자리마다 맞춘다.
// 개수가 다르면 손대지 않음 (뒤의 개수/서명 검증이 잡아냄).
function repairMacroCasing(sourceText, outputText) {
    const macroPattern = /\{\{[\s\S]*?\}\}/g;
    const sourceMacros = String(sourceText || '').match(macroPattern) || [];
    const outputMacros = String(outputText || '').match(macroPattern) || [];
    if (sourceMacros.length === 0 || sourceMacros.length !== outputMacros.length) return outputText;
    let index = 0;
    let changed = false;
    const repaired = String(outputText || '').replace(macroPattern, (macro) => {
        const expected = sourceMacros[index++];
        if (expected !== macro && expected.toLowerCase() === macro.toLowerCase()) {
            changed = true;
            return expected;
        }
        return macro;
    });
    return changed ? repaired : outputText;
}

// 응답 전체를 감싼 단일 HTML/XML 래퍼는 번역 대상이 아니라 운반용 구조다.
// Gemma/MiMo 계열이 <Response>...</Response>만 벗겨도 장문 전체를 재호출하던
// 비용 폭탄을 막기 위해, 동일 이름의 바깥 래퍼만 원문 표기로 결정론적 복원한다.
function restoreSafeOuterEnvelope(sourceText, outputText) {
    const sourceTrimmed = String(sourceText || '').trim();
    const outputTrimmed = String(outputText || '').trim();
    const outer = sourceTrimmed.match(/^(<([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?>)([\s\S]*)(<\/\2>)$/);
    if (!outer || !outputTrimmed) {
        return { text: String(outputText || ''), repaired: false };
    }

    const [, sourceOpen, tagName, , sourceClose] = outer;
    const escapedTag = escapeRegExp(tagName);
    const outputOpen = outputTrimmed.match(new RegExp(`^<${escapedTag}(?:\\s[^<>]*?)?>`, 'i'));
    const outputClose = outputTrimmed.match(new RegExp(`<\\/${escapedTag}>$`, 'i'));
    const strayOpen = new RegExp(`<${escapedTag}(?:\\s|>)`, 'i').test(outputTrimmed.slice(outputOpen?.[0]?.length || 0));
    const strayClose = new RegExp(`<\\/${escapedTag}>`, 'i').test(
        outputClose ? outputTrimmed.slice(0, -outputClose[0].length) : outputTrimmed
    );

    // 같은 이름의 래퍼가 본문 안에 따로 있으면 무엇이 바깥 경계인지 단정하지 않는다.
    if (strayOpen || strayClose) {
        return { text: String(outputText || ''), repaired: false };
    }

    let repaired = outputTrimmed;
    if (outputOpen) repaired = sourceOpen + repaired.slice(outputOpen[0].length);
    else repaired = sourceOpen + repaired;
    if (outputClose) repaired = repaired.slice(0, -outputClose[0].length) + sourceClose;
    else repaired += sourceClose;

    return {
        text: repaired,
        repaired: repaired !== outputTrimmed
    };
}

export function validateTranslationStructure(source, output, options = {}) {
    const sourceText = String(source || '');
    const envelope = restoreSafeOuterEnvelope(sourceText, String(output || ''));
    if (envelope.repaired) {
        console.log('[CAT] 🔧 바깥 응답 래퍼 자동 복원');
    }
    const normalized = repairStructuredKeyPrefixes(sourceText, envelope.text);
    const caseRepaired = repairMacroCasing(sourceText, normalized.text);
    if (caseRepaired !== normalized.text) {
        console.log('[CAT] 🔧 매크로 대소문자 원문 표기로 복원');
        normalized.text = caseRepaired;
    }
    const validationText = options.allowBilingualMacroCopies === true
        ? normalizeBilingualMacroCopiesForValidation(normalized.text)
        : normalized.text;
    const parity = compareProtectedStructure(sourceText, validationText, {
        blockDividerGrowth: options.sourceTruncated === true,
        allowKoreanGrammarMacroOmission: options.allowKoreanGrammarMacroOmission === true,
        // 🚨 v1.1.12 (R): restore의 문단 내 재배열 면제 플래그 전달
        allowInlineMacroReorder: options.allowInlineMacroReorder === true
    });
    if (!parity.ok) {
        const recovered = recoverBoundaryContextLeak(sourceText, normalized.text, options);
        if (recovered) {
            return {
                ok: true,
                reason: null,
                text: recovered.text,
                repairedKeys: recovered.repairedKeys,
                boundaryRecovery: recovered.boundaryRecovery
            };
        }
    }
    return {
        ...parity,
        text: normalized.text,
        repairedKeys: normalized.repairedKeys,
        boundaryRecovery: null,
        softNote: [
            envelope.repaired ? '바깥 응답 래퍼 자동 복원' : null,
            parity.softNote || null
        ].filter(Boolean).join(' / ') || null
    };
}

// 일부 모델이 이전 문맥의 완결된 정보블럭을 현재 번역 앞뒤에 붙이는 경우만 복구한다.
// 내부 삽입이나 후보가 둘 이상인 응답은 원문 일부를 잘못 버릴 수 있으므로 그대로 거부한다.
function recoverBoundaryContextLeak(source, output, options = {}) {
    const sourceMatches = getStructureMatches(source);
    const outputMatches = getStructureMatches(output);
    if (sourceMatches.length === 0 || outputMatches.length <= sourceMatches.length) {
        return null;
    }

    const candidates = new Map();
    const lastOffset = outputMatches.length - sourceMatches.length;
    for (let offset = 0; offset <= lastOffset; offset++) {
        let signatureMatches = true;
        for (let i = 0; i < sourceMatches.length; i++) {
            if (outputMatches[offset + i].value !== sourceMatches[i].value) {
                signatureMatches = false;
                break;
            }
        }
        if (!signatureMatches) continue;

        const hasPrefix = offset > 0;
        const suffixIndex = offset + sourceMatches.length;
        const hasSuffix = suffixIndex < outputMatches.length;
        if (!hasPrefix && !hasSuffix) continue;

        const start = hasPrefix ? outputMatches[offset - 1].end : 0;
        const end = hasSuffix ? outputMatches[suffixIndex].index : output.length;
        const removedPrefix = hasPrefix ? output.slice(0, start) : '';
        const removedSuffix = hasSuffix ? output.slice(end) : '';
        const prefixBlocks = hasPrefix ? countCompleteBoundaryFenceBlocks(removedPrefix) : 0;
        const suffixBlocks = hasSuffix ? countCompleteBoundaryFenceBlocks(removedSuffix) : 0;
        if (hasPrefix && prefixBlocks === 0) continue;
        if (hasSuffix && suffixBlocks === 0) continue;

        const candidateText = output.slice(start, end).trim();
        const normalized = repairStructuredKeyPrefixes(source, candidateText);
        const parity = compareProtectedStructure(source, normalized.text, options);
        if (!parity.ok) continue;

        candidates.set(normalized.text, {
            text: normalized.text,
            repairedKeys: normalized.repairedKeys,
            boundaryRecovery: {
                removedPrefix: hasPrefix,
                removedSuffix: hasSuffix,
                removedFenceBlocks: prefixBlocks + suffixBlocks
            }
        });
    }

    return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function countCompleteBoundaryFenceBlocks(fragment) {
    const text = String(fragment || '');
    const fenceMarkers = text.match(/```[^\n]*/g) || [];
    const completeBlocks = text.match(/```[^\n]*\n[\s\S]*?```/g) || [];
    if (completeBlocks.length === 0 || fenceMarkers.length !== completeBlocks.length * 2) {
        return 0;
    }
    return completeBlocks.length;
}

function compareProtectedStructure(source, output, options = {}) {
    const sourceSignature = getStructureSignature(source);
    const outputSignature = getStructureSignature(output);
    // 🚨 beta.5: 구분선(-{3,} 등) 요소는 "느슨한 축"으로 분리한다.
    // 구분선 하나 어긋났다고 번역 전체를 폐기하는 형벌 과잉이 실사용 오류의
    // 주범이었음(8→7, 8→9, 0→5 실측). 구분선은 개수 증감 모두 소프트 허용하고,
    // 펜스/태그/매크로 같은 "진짜 깨지면 안 되는 축"만 엄격 검증을 유지한다.
    // 예외: 절단된 소스에서 구분선 '증가'는 모델이 절단점 너머를 창작한
    // 카나리아이므로 하드 실패 유지 → 절단점 준수 재시도가 발동하게 한다.
    const srcRest = sourceSignature.filter(el => !isDividerElement(el));
    const outRest = outputSignature.filter(el => !isDividerElement(el));
    const srcDiv = sourceSignature.length - srcRest.length;
    const outDiv = outputSignature.length - outRest.length;
    const softNotes = [];

    // 매크로 축은 유일 집합 기준으로 비교하되, 한국어 문법 슬롯
    // ({{obj}}/{{poss}}/{{subj}})만 문맥상 생략을 소프트 허용한다.
    // 엔티티 매크로 소실·신종은 계속 하드 거부하고, 복제·순서는 자유다.
    const _isMacroVal = v => /^\{\{[\s\S]*?\}\}$/.test(v);
    const _srcMacroSet = new Set(srcRest.filter(_isMacroVal).map(v => v.toLowerCase()));
    const _outMacroSet = new Set(outRest.filter(_isMacroVal).map(v => v.toLowerCase()));
    for (const v of _srcMacroSet) if (!_outMacroSet.has(v)) {
        if (options.allowKoreanGrammarMacroOmission === true && isKoreanGrammarMacro(v)) {
            softNotes.push(`한국어 문법 매크로 생략 허용: ${v}`);
            continue;
        }
        return { ok: false, reason: `구조 요소 변경: ${v}→(소실)` };
    }
    for (const v of _outMacroSet) if (!_srcMacroSet.has(v)) {
        return { ok: false, reason: `구조 요소 변경: (원문 없음)→${v}` };
    }
    const srcHard = srcRest.filter(v => !_isMacroVal(v));
    const outHard = outRest.filter(v => !_isMacroVal(v));
    if (srcHard.length !== outHard.length) {
        const srcAudit = auditDividerLines(source);
        const outAudit = auditDividerLines(output);
        return {
            ok: false,
            reason: `구조 요소 개수 불일치: ${srcHard.length}→${outHard.length}`,
            detail: `원문 요소: ${sourceSignature.join(' | ').slice(0, 200)}\n출력 요소: ${outputSignature.join(' | ').slice(0, 200)}\n원문 구분선 ${srcAudit.matched.length}개 / 출력 구분선 ${outAudit.matched.length}개` +
                (outAudit.nearMiss.length ? `\n⚠️ 출력의 매칭 실패 유사 구분선:\n${outAudit.nearMiss.slice(0, 5).join('\n')}` : '') +
                (srcAudit.nearMiss.length ? `\n⚠️ 원문의 매칭 실패 유사 구분선:\n${srcAudit.nearMiss.slice(0, 5).join('\n')}` : '')
        };
    }
    if (srcDiv !== outDiv) {
        if (outDiv > srcDiv && options.blockDividerGrowth) {
            return {
                ok: false,
                reason: `구조 요소 개수 불일치: ${sourceSignature.length}→${outputSignature.length}`,
                detail: `절단된 원문에서 구분선이 ${srcDiv}→${outDiv}로 늘어남 — 절단점 너머 창작 의심`
            };
        }
        const dividerNote = `구분선 ${srcDiv}→${outDiv} ${outDiv < srcDiv ? '감소' : '증가'} — 소프트 허용 (번역 유지)`;
        softNotes.push(dividerNote);
        console.warn(`[CAT] ⚠️ ${dividerNote}`);
    }
    // 🚨 v1.1.12 (R): 문단 내 inline 재배열 면제가 확정된 호출에서만,
    // 매크로 축을 '순서 비교'에서 '다중집합 비교'로 전환 (구분선 소프트 축과 동일 구조).
    // 게이트: options.allowInlineMacroReorder — restore의 면제 판정이 참일 때만 전달됨.
    // v1.2.0: 순서 비교는 하드 요소만 (매크로는 위에서 집합으로 이미 판정)
    const cmpSrc = srcHard, cmpOut = outHard;
    for (let i = 0; i < cmpSrc.length; i++) {
        if (cmpSrc[i] !== cmpOut[i]) {
            // 🚨 beta.3: {{User}}↔{{user}}처럼 대소문자만 다른 매크로는 ST가 동일하게
            // 치환하므로 구조 변경으로 취급하지 않는다 (모델의 케이스 통일 습관 흡수)
            const isMacroPair = /^\{\{[\s\S]*\}\}$/.test(cmpSrc[i]) &&
                /^\{\{[\s\S]*\}\}$/.test(cmpOut[i]) &&
                cmpSrc[i].toLowerCase() === cmpOut[i].toLowerCase();
            if (isMacroPair) continue;
            return { ok: false, reason: `구조 요소 변경: ${cmpSrc[i]}→${cmpOut[i]}` };
        }
    }
    
    const sourceBlocks = getFencedBlockShapes(source);
    const outputBlocks = getFencedBlockShapes(output);
    if (sourceBlocks.length !== outputBlocks.length) {
        return { ok: false, reason: `코드블럭 개수 불일치: ${sourceBlocks.length}→${outputBlocks.length}` };
    }
    for (let i = 0; i < sourceBlocks.length; i++) {
        const src = sourceBlocks[i];
        const out = outputBlocks[i];
        if (src.lines.length !== out.lines.length) {
            return { ok: false, reason: `코드블럭 ${i + 1} 줄 수 불일치: ${src.lines.length}→${out.lines.length}` };
        }
        for (let lineIndex = 0; lineIndex < src.lines.length; lineIndex++) {
            const srcLine = src.lines[lineIndex];
            const outLine = out.lines[lineIndex];
            const srcIndent = srcLine.match(/^[\t ]*/)?.[0] || '';
            const outIndent = outLine.match(/^[\t ]*/)?.[0] || '';
            if (srcIndent !== outIndent) {
                return { ok: false, reason: `코드블럭 ${i + 1} 들여쓰기 변경 (${lineIndex + 1}행)` };
            }
            if (!srcLine.trim() && outLine.trim()) {
                return { ok: false, reason: `코드블럭 ${i + 1} 빈 줄 변경 (${lineIndex + 1}행)` };
            }
            
            const keyPrefix = getStructuredKeyPrefix(srcLine, src.language);
            if (keyPrefix && !outLine.startsWith(keyPrefix)) {
                return { ok: false, reason: `코드블럭 ${i + 1} 키 변경 (${lineIndex + 1}행)` };
            }
        }
    }

    // 🚨 v1.2.0: 매크로는 배치/구간 경계가 아님 — 제거 후 레이아웃 계산
    const _stripMacros = t => String(t).replace(/\{\{[\s\S]*?\}\}/g, '');
    const sourceLayout = getStructureLayout(_stripMacros(source));
    const outputLayout = getStructureLayout(_stripMacros(output));
    if (sourceLayout.regions !== outputLayout.regions) {
        return {
            ok: false,
            reason: `구조 요소 배치 개수 불일치: ${sourceLayout.regions}→${outputLayout.regions}`
        };
    }
    for (let i = 0; i < sourceLayout.contentGaps.length; i++) {
        if (sourceLayout.contentGaps[i] !== outputLayout.contentGaps[i]) {
            // 🚨 v1.1.4: gap 0의 검증된 소유격 매크로 재배치만 면제.
            // 캐시·fallback 경로는 세그먼트 검증 없이 이 함수를 직접 호출하므로
            // 여기서도 같은 공용 코어로 판정해야 정상 캐시가 폐기되지 않는다.
            // gap 1 이후 mismatch·region 불일치·코드블럭 검사는 전부 그대로 유지.
            if (i === 0 && isSafeLeadingPossessiveLayoutReorder(source, output)) {
                continue;
            }
            // 🚨 v1.1.12 (R): 면제 호출에선 매크로 재배열로 인한 구간 이동을 허용
            if (options.allowInlineMacroReorder === true) continue;
            return { ok: false, reason: `구조 요소 위치 변경 (${i + 1}구간)` };
        }
    }
    return { ok: true, reason: null, softNote: softNotes.join(' / ') || null };
}

function getStructureSignature(text) {
    return getStructureMatches(text).map(item => item.value);
}

function getStructureMatches(text) {
    const matches = [];
    const patterns = [
        // 닫는 펜스 바로 뒤의 </Response>까지 한 요소로 삼키지 않는다.
        // 언어 식별자만 펜스 요소에 포함하고 뒤따르는 태그는 별도 요소로 센다.
        /```[\t ]*[A-Za-z0-9_+.-]*/g,
        /<!--|-->|<\/?[a-zA-Z][^>]*>|\{\{[\s\S]*?\}\}/g,
        dividerLineRegex('gm')
    ];
    patterns.forEach((pattern) => {
        for (const match of String(text || '').matchAll(pattern)) {
            matches.push({
                index: match.index,
                end: match.index + match[0].length,
                value: match[0]
            });
        }
    });
    return matches.sort((a, b) => a.index - b.index);
}

function getFencedBlockShapes(text) {
    return [...String(text || '').matchAll(/```([^\n]*)\n([\s\S]*?)```/g)]
        .map(match => {
            const openingLength = match[0].indexOf('\n') + 1;
            const contentStart = match.index + openingLength;
            return {
                language: normalizeFenceLanguage(match[1]),
                lines: match[2].split('\n'),
                contentStart,
                contentEnd: contentStart + match[2].length
            };
        });
}

function normalizeFenceLanguage(info) {
    return String(info || '').trim().split(/\s+/)[0].toLowerCase();
}

function repairStructuredKeyPrefixes(source, output) {
    const sourceBlocks = getFencedBlockShapes(source);
    const outputBlocks = getFencedBlockShapes(output);
    if (sourceBlocks.length !== outputBlocks.length) {
        return { text: output, repairedKeys: 0 };
    }

    let normalized = String(output || '');
    let repairedKeys = 0;
    const replacements = [];

    for (let blockIndex = 0; blockIndex < sourceBlocks.length; blockIndex++) {
        const src = sourceBlocks[blockIndex];
        const out = outputBlocks[blockIndex];
        if (src.language !== out.language || src.lines.length !== out.lines.length) continue;

        const fixedLines = [...out.lines];
        let blockChanged = false;
        for (let lineIndex = 0; lineIndex < src.lines.length; lineIndex++) {
            const sourcePrefix = getStructuredKeyPrefix(src.lines[lineIndex], src.language);
            if (!sourcePrefix || fixedLines[lineIndex].startsWith(sourcePrefix)) continue;

            const outputPrefix = getStructuredKeyPrefix(fixedLines[lineIndex], out.language, true);
            if (!outputPrefix) continue;
            fixedLines[lineIndex] = sourcePrefix + fixedLines[lineIndex].slice(outputPrefix.length);
            repairedKeys++;
            blockChanged = true;
        }

        if (blockChanged) {
            replacements.push({
                start: out.contentStart,
                end: out.contentEnd,
                text: fixedLines.join('\n')
            });
        }
    }

    replacements.sort((a, b) => b.start - a.start);
    for (const replacement of replacements) {
        normalized = normalized.slice(0, replacement.start) +
            replacement.text +
            normalized.slice(replacement.end);
    }
    return { text: normalized, repairedKeys };
}

function getStructureLayout(text) {
    const source = String(text || '');
    // 🚨 beta.5: 구분선은 소프트 축으로 이동 → 배치(layout) 검사에서도 제외.
    // 포함된 채로 두면 구분선 개수가 소프트 허용으로 통과한 케이스가
    // 여기서 "배치 개수 불일치"로 다시 죽는 이중 처벌이 발생한다.
    const regions = [...source.matchAll(
        /```[^\n]*\n[\s\S]*?```|<!--|-->|<\/?[a-zA-Z][^>]*>|\{\{[\s\S]*?\}\}/g
    )];
    const contentGaps = [];
    let cursor = 0;
    
    for (const region of regions) {
        contentGaps.push(/\S/.test(source.slice(cursor, region.index)));
        cursor = region.index + region[0].length;
    }
    contentGaps.push(/\S/.test(source.slice(cursor)));
    
    return { regions: regions.length, contentGaps };
}

function getStructuredKeyPrefix(line, language, allowTightValue = false) {
    if (/^(?:json|jsonc|json5)$/.test(language)) {
        const jsonKey = line.match(/^(\s*"(?:(?:\\.)|[^"\\])+"\s*:\s*)/);
        if (jsonKey) return jsonKey[1];
        if (language !== 'json') {
            const json5Key = line.match(/^(\s*[\p{L}_$][\p{L}\p{N}_$.-]*\s*:\s*)/u);
            return json5Key ? json5Key[1] : null;
        }
        return null;
    }

    if (/^(?:yaml|yml)$/.test(language)) {
        const yamlKey = allowTightValue
            ? line.match(
                /^(\s*(?:-\s*)?(?:(?:"(?:(?:\\.)|[^"\\])*"|'(?:''|[^'])*')|[\p{L}_][\p{L}\p{N}_. -]{0,79})\s*:\s*)/u
            )
            : line.match(
                /^(\s*(?:-\s*)?(?:(?:"(?:(?:\\.)|[^"\\])*"|'(?:''|[^'])*')|[\p{L}_][\p{L}\p{N}_. -]{0,79})\s*:(?:[ \t]+|$))/u
            );
        return yamlKey ? yamlKey[1] : null;
    }

    return null;
}

// 🚨 문단 구조 자동 복구 (한 덩어리로 합쳐진 경우)
function restoreParagraphStructure(text, targetParagraphCount) {
    // 대사 시작/종료 + 묘사 전환 패턴으로 분할
    // 1. 닫는 따옴표 뒤 + 한국어 시작 → 문단 경계
    // 2. 한국어 종결 뒤 + 여는 따옴표 → 문단 경계
    
    // 자연스러운 분할 후보 위치 (점수 부여)
    const candidates = [];
    const len = text.length;
    
    // 패턴 1: "..." 다음 문장 (대사 종료 후 묘사)
    for (let m of text.matchAll(/(["」』])\s+([가-힣A-Z])/g)) {
        candidates.push({ pos: m.index + m[1].length, score: 3 });
    }
    
    // 패턴 2: 문장 끝(다.) 다음 대사 (묘사 종료 후 대사)
    for (let m of text.matchAll(/([다요까네])\.\s+(["「『])/g)) {
        candidates.push({ pos: m.index + 2, score: 3 });
    }
    
    // 패턴 3: 일반 문장 종료 (다./요./까?)
    for (let m of text.matchAll(/([다요까네])\.\s+([가-힣])/g)) {
        candidates.push({ pos: m.index + 2, score: 1 });
    }
    
    if (candidates.length === 0) return text; // 분할 불가
    
    // 후보 정렬 (위치 순)
    candidates.sort((a, b) => a.pos - b.pos);
    
    // 목표 문단 수에 가장 가까운 분할점 선택
    const breakCount = targetParagraphCount - 1;
    if (candidates.length < breakCount) return text; // 후보가 부족
    
    // 균등 분할 위치 계산
    const ideal = [];
    for (let i = 1; i <= breakCount; i++) {
        ideal.push((len * i) / targetParagraphCount);
    }
    
    // 각 ideal 위치에 가장 가까운 후보 선택
    const breakPoints = [];
    const used = new Set();
    for (const idealPos of ideal) {
        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < candidates.length; i++) {
            if (used.has(i)) continue;
            const dist = Math.abs(candidates[i].pos - idealPos) - candidates[i].score * 30;
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        if (best !== null) {
            breakPoints.push(candidates[best].pos);
            used.add(best);
        }
    }
    
    breakPoints.sort((a, b) => a - b);
    
    // 분할점에 \n\n 삽입
    let result = '';
    let last = 0;
    for (const bp of breakPoints) {
        result += text.substring(last, bp) + '\n\n';
        last = bp;
    }
    result += text.substring(last);
    
    console.log(`[CAT] 🔧 문단 자동 복구: 1개 → ${targetParagraphCount}개`);
    return result;
}

// 🚨 따옴표 균형 검사 및 복구
function balanceQuotes(text, originalText) {
    // 🚨 beta.3: 구조 잠금 원문(펜스/태그/구분선)에서는 따옴표 자동 복구를 건너뛴다.
    // '"'+text 프리펜드가 첫 줄 구분선을 “--- 로 오염시켜 구조 검증을 깨뜨렸음(구분선 8→7 사건).
    // 코스메틱 복구보다 구조 보존이 우선이고, 구조는 어차피 뒤의 검증이 지킨다.
    if (originalText && (/```/.test(originalText) || /<\/?[a-zA-Z][^>]*>/.test(originalText) || dividerLineRegex('m').test(originalText))) {
        return text;
    }
    // 🚨 beta.3: 원문 자체가 ASCII 따옴표 홀수면(절단 메시지 등) 번역의 홀수도 정상 — 복구하지 않음
    if (originalText && ((originalText.match(/"/g) || []).length % 2 !== 0)) {
        return text;
    }
    // 영어 따옴표: " (smart quotes는 별도)
    // 한국어 따옴표: "", 「」, 『』
    
    const countQuotes = (s, pattern) => (s.match(pattern) || []).length;
    
    // 1. 첫 줄 대사 따옴표 누락 복구
    // 원문 첫 줄이 "..." 패턴인데 번역 첫 줄이 따옴표 없이 시작하면 복구
    if (originalText) {
        const origFirstLine = originalText.split(/\n/)[0]?.trim();
        const transFirstLine = text.split(/\n/)[0]?.trim();
        
        if (origFirstLine && transFirstLine) {
            const origStartsWithQuote = /^["「『]/.test(origFirstLine);
            const transStartsWithQuote = /^["「『]/.test(transFirstLine);
            
            // 원문은 따옴표로 시작, 번역은 안 그러면 → 첫 따옴표 추가
            if (origStartsWithQuote && !transStartsWithQuote) {
                // 한국어 따옴표 ㅍ스타일 매칭
                const quoteChar = origFirstLine[0];
                const targetQuote = quoteChar === '"' ? '"' : quoteChar;
                text = targetQuote + text;
                console.log(`[CAT] 🔧 첫 줄 따옴표 복구: ${targetQuote} 추가`);
            }
        }
    }
    
    // 2. 따옴표 균형 검사 (열린 vs 닫힌)
    // ASCII 따옴표는 양방향이라 짝수면 OK
    const ascii = countQuotes(text, /"/g);
    if (ascii % 2 !== 0) {
        // 홀수 → 마지막에 " 추가 (닫는 따옴표 누락 가능성)
        text = text.trimEnd() + '"';
        console.log(`[CAT] 🔧 ASCII 따옴표 균형 복구: 닫는 " 추가`);
    }
    
    // 한국어 큰따옴표
    const koOpen = countQuotes(text, /"/g);
    const koClose = countQuotes(text, /"/g);
    if (koOpen > koClose) {
        text = text.trimEnd() + '"';
        console.log(`[CAT] 🔧 한국어 따옴표 균형 복구: 닫는 " 추가`);
    } else if (koClose > koOpen) {
        // 닫는 게 더 많음 → 맨 앞에 열린 따옴표 추가
        text = '"' + text;
        console.log(`[CAT] 🔧 한국어 따옴표 균형 복구: 여는 " 앞에 추가`);
    }
    
    return text;
}

export function normalizeContextRange(value, fallback = 1) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(6, Math.max(0, parsed)) : fallback;
}

export function resolveMessageEventId(event) {
    const value = event && typeof event === 'object'
        ? event.messageId ?? event.message_id ?? event.mesId ?? event.id : event;
    if (!/^(0|[1-9]\d*)$/.test(String(value))) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

export function createAutoTranslationScheduler({ getChat, getMode, process, onError, delay = 500 }) {
    const pending = new Map();
    return event => {
        const id = resolveMessageEventId(event);
        const chat = getChat();
        const msg = chat?.[id];
        if (id === null || !msg || !['output', 'both'].includes(getMode())) return;
        const old = pending.get(id);
        if (old) clearTimeout(old);
        const swipe = msg.swipe_id;
        const timer = setTimeout(async () => {
            if (pending.get(id) !== timer) return;
            pending.delete(id);
            if (getChat() !== chat || chat[id] !== msg || msg.swipe_id !== swipe ||
                !['output', 'both'].includes(getMode()) || msg.is_user || msg.is_system || msg.is_hidden ||
                !String(msg.mes || '').trim()) return;
            try { await process(id, false, null, false, true); }
            catch (error) { onError(error); }
        }, delay);
        pending.set(id, timer);
    };
}

export function suggestDictionarySource(selectedText, originalText, dictionary = '') {
    const selected = String(selectedText || '').trim();
    const original = String(originalText || '');
    const hasWord = word => new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i').test(original);
    const mapped = dictionary.split('\n').map(line => line.split('='))
        .filter(parts => parts.length >= 2 && parts.slice(1).join('=').trim() === selected)
        .map(parts => parts[0].trim()).filter(word => word && hasWord(word));
    if (mapped.length === 1) return { source: mapped[0], candidates: mapped, reason: 'dictionary' };
    const ignored = new Set('The A An He She It I They We You His Her Their This That Then But And Not No Yes On In At To From With When What Why How There Here As My Our Your Its Of For Is Was Were Be Do Did Had Have So Now Still After Before Once Something Somewhere One Two Three Response SOURCE English Korean'.split(' '));
    const prose = original.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]*>/g, ' ');
    const words = [...prose.matchAll(/\b[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)*\b/g)].map(match => match[0]).filter(word => !ignored.has(word));
    const fullNames = [...prose.matchAll(/\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,2}\b/g)]
        .map(match => match[0]).filter(name => name.split(/[ \t]+/).every(word => !ignored.has(word)));
    const candidates = [...new Set([...mapped, ...fullNames, ...words])].slice(0, 60);
    const skeleton = name => {
        const initial = ['g','kk','n','d','tt','l','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
        const final = ['','g','kk','gs','n','nj','nh','d','l','lg','lm','lb','ls','lt','lp','lh','m','b','bs','s','ss','ng','j','ch','k','t','p','h'];
        let value = [...name].map(ch => {
            const code = ch.charCodeAt(0) - 0xAC00;
            return code >= 0 && code < 11172 ? initial[Math.floor(code / 588)] + final[code % 28] : ch;
        }).join('').toLowerCase();
        return value.replace(/ph/g, 'f').replace(/th/g, 't').replace(/x/g, 'ks').replace(/c(?=[iey])/g, 's')
            .replace(/[cgq]/g, 'k').replace(/v/g, 'b').replace(/r/g, 'l').replace(/[aeiouyw\s'’-]/g, '').replace(/(.)\1+/g, '$1');
    };
    const key = skeleton(selected);
    const matches = key.length >= 2 ? candidates.filter(word => skeleton(word) === key) : [];
    return { source: matches.length === 1 ? matches[0] : '', candidates, reason: matches.length === 1 ? 'spelling-candidate' : 'ambiguous' };
}

export function getCacheModelKey(settings, stContext = null) {
    const context = stContext || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null);
    const profile = context?.extensionSettings?.connectionManager?.profiles?.find(p => String(p.id) === String(settings.profile));
    const fields = ['model', 'modelName', 'model_name', 'modelId', 'model_id', 'api', 'mode', 'api-url', 'api_url', 'endpoint', 'source', 'preset', 'instruct', 'proxy', 'prompt-post-processing'];
    const pickIdentity = (value, depth = 0) => [
        ...fields.map(field => [field, value?.[field] ?? '']),
        ...(depth < 3 ? ['settings', 'config', 'connection', 'apiSettings', 'parameters', 'params', 'provider'].filter(field => value?.[field] && typeof value[field] === 'object').map(field => [field, pickIdentity(value[field], depth + 1)]) : [])
    ];
    const identity = settings.profile
        ? pickIdentity(profile)
        : [settings.directModel || '', settings.customModelName || '', settings.vertexProject || '', settings.vertexRegion || '', settings.maxTokens || ''];
    const identityHash = hashCacheSetting(JSON.stringify(identity));
    let key;
    if (settings.profile) key = `profile:${settings.profile}`;
    else key = settings.directModel || 'default';
    
    const dialogueMode = settings.dialogueBilingual || 'off';
    const literalMode = settings.literalBilingual === 'on' ? 'on' : 'off';
    const style = settings.style || 'normal';
    const temperature = Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.3;
    const commonPromptHash = hashCacheSetting(settings.commonPrompt || settings.userPrompt || '');
    const narrationPromptHash = hashCacheSetting(settings.narrationPrompt || '');
    const dialoguePromptHash = hashCacheSetting(settings.dialoguePrompt || '');
    const dictionaryHash = hashCacheSetting(settings.dictionary || '');
    const contextRange = Number.isFinite(Number(settings.contextRange)) ? Number(settings.contextRange) : 1;
    const fastMode = settings.nonGeminiFastMode || 'off';
    
    return `${key}::cache-v6::dialogue:${dialogueMode}::literal:${literalMode}` +
        `::style:${style}::temp:${temperature}::context:${contextRange}` +
        `::fast:${fastMode}::commonPrompt:${commonPromptHash}::narrationPrompt:${narrationPromptHash}::dialoguePrompt:${dialoguePromptHash}::dict:${dictionaryHash}::identity:${identityHash}`;
}

function hashCacheSetting(value) {
    let hash = 0x811c9dc5;
    const normalized = String(value).replace(/\r\n/g, '\n').trim();
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function getModelTheme(modelName) {
    if (!modelName) return 'cat';
    const lower = modelName.toLowerCase();
    if (lower.includes('pro') || lower.includes('프로') || lower.includes('호랑이') || lower.includes('tiger')) return 'tiger';
    if (lower.includes('flash') || lower.includes('플래') || lower.includes('플레') || lower.includes('고양이') || lower.includes('cat')) return 'cat';
    if (lower.includes('vertex')) {
        if (lower.includes('pro')) return 'tiger';
        return 'cat';
    }
    return 'cat';
}

// 🚨 언어 감지용 메타 토큰 제거: ooc/rp 약어, {{매크로}}, <태그>, URL이
// 짧은 인풋의 언어 비율을 왜곡하는 것 방지 (감지/경고 판정 공용)
export function stripMetaForDetection(text) {
    return String(text || '')
        .replace(/\{\{[^}]*\}\}/g, '')                          // {{char}}, {{user}} 등 매크로
        .replace(/<[^>]{1,30}>/g, '')                           // <user>, <char> 등 태그
        .replace(/\b(ooc|OOC|rp|RP|ic|IC|btw|ps|PS|ai|AI)\b/g, '') // RP 메타 약어
        .replace(/https?:\/\/\S+/g, '');                        // URL
}

export function analyzeLanguage(text) {
    const stripped = stripMetaForDetection(text);
    const chars = {
        Korean: (stripped.match(/[가-힣]/g) || []).length,
        English: (stripped.match(/[a-zA-Z]/g) || []).length,
        Japanese: (stripped.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length,
        Chinese: (stripped.match(/[\u4E00-\u9FFF]/g) || []).length
    };
    const words = {
        Korean: (stripped.match(/[가-힣]+/g) || []).length,
        English: (stripped.match(/[a-zA-Z]+/g) || []).length,
        Japanese: (stripped.match(/[\u3040-\u309F\u30A0-\u30FF]+/g) || []).length,
        Chinese: chars.Chinese
    };
    const scores = {
        Korean: words.Korean + chars.Korean / 2.5,
        English: words.English + chars.English / 5,
        Japanese: words.Japanese + chars.Japanese / 2,
        Chinese: chars.Chinese / 1.5
    };
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const totalScore = ranked.reduce((sum, [, score]) => sum + score, 0);
    const dominant = totalScore > 0 ? ranked[0][0] : null;
    const confidence = totalScore > 0 ? ranked[0][1] / totalScore : 0;

    return {
        stripped,
        chars,
        words,
        scores,
        dominant,
        confidence,
        total: Object.values(chars).reduce((sum, count) => sum + count, 0)
    };
}

export function isClearlyLanguage(textOrAnalysis, language, minConfidence = 0.72) {
    const analysis = typeof textOrAnalysis === 'string'
        ? analyzeLanguage(textOrAnalysis)
        : textOrAnalysis;
    if (!analysis || !language || analysis.total === 0) return false;

    const chars = analysis.chars?.[language] || 0;
    const words = analysis.words?.[language] || 0;
    const competingChars = Object.entries(analysis.chars || {})
        .filter(([key]) => key !== language)
        .reduce((sum, [, count]) => sum + count, 0);

    if (chars === 0) return false;
    if (competingChars === 0 && chars >= 2) return true;
    if (analysis.dominant !== language) return false;
    if (words >= 2 && analysis.confidence >= minConfidence) return true;
    return chars >= 4 && analysis.confidence >= Math.max(0.82, minConfidence);
}

export function getInputTargetLanguage(settings = {}) {
    const dialogueMap = { 'ko-en': 'English', 'ko-ja': 'Japanese', 'ko-zh': 'Chinese' };
    const dialogueMode = settings.dialogueBilingual || 'off';
    if (dialogueMap[dialogueMode]) return dialogueMap[dialogueMode];

    const bidirectionalMode = settings.bidirectional || 'off';
    if (dialogueMap[bidirectionalMode]) return dialogueMap[bidirectionalMode];

    const configuredTarget = settings.targetLang || 'Korean';
    return configuredTarget === 'Korean' ? 'English' : configuredTarget;
}

// 🚨 v1.1.4-beta.3: 인풋(사용자 입력) 번역 전용 프롬프트 해석 — 단일 출처.
// 인풋 진입점 3곳(index.js 자동/스마트, ui.js 버튼)이 공용한다.
// - 공통 지침은 인풋에도 적용하고, 인풋 전용 → 대사 → 서술 순서의 세부 지침을 합친다.
// - 구버전 설정은 마지막으로 userPrompt를 공통 지침처럼 읽어 업데이트 직후에도 동작을 보존한다.
// - 호출부는 반환값을 dialoguePrompt로 전달하므로 인풋 발화에만 적용된다.
export function resolveInputUserPrompt(settings = {}) {
    const commonPrompt = String(settings.commonPrompt || settings.userPrompt || '').trim();
    const specificPrompt = String(settings.inputUserPrompt || settings.dialoguePrompt || settings.narrationPrompt || '').trim();
    return [...new Set([commonPrompt, specificPrompt].filter(Boolean))].join('\n');
}

export function resolveInputTranslationDirection(text, settings = {}) {
    const analysis = analyzeLanguage(text);
    let targetLang = getInputTargetLanguage(settings);
    // 🚨 beta.9.2: 양방향(ko-en) 입력 방향 전환 복원 — 입력이 이미 목표 언어(영어)면
    // "그대로 전송"으로 중단하지 않고 반대 방향(한국어)으로 번역한다.
    // 양방향 off일 때는 기존 동작(같은 언어 → 전송 안내) 유지.
    if ((settings.bidirectional || 'off') === 'ko-en' && isClearlyLanguage(analysis, targetLang)) {
        targetLang = targetLang === 'English' ? 'Korean' : 'English';
    }
    return {
        targetLang,
        sourceLanguage: analysis.dominant,
        shouldTranslate: analysis.total > 0 && !isClearlyLanguage(analysis, targetLang),
        analysis
    };
}

const INTERNAL_INPUT_LANGUAGES = new Set([
    'English', 'Japanese', 'Chinese', 'German', 'Russian', 'French'
]);

export function normalizeInternalInputLanguage(value) {
    const normalized = String(value || '').trim();
    return INTERNAL_INPUT_LANGUAGES.has(normalized) ? normalized : 'English';
}

export function shouldKeepInternalInputEnter(eventLike, internalInputEnabled = false) {
    if (!internalInputEnabled || eventLike?.type !== 'keydown') return false;
    const isEnter = eventLike?.key === 'Enter' || eventLike?.keyCode === 13;
    if (!isEnter || eventLike?.target?.id !== 'send_textarea') return false;
    // 일반 Enter는 IME 상태와 무관하게 전송 경로에서 제외한다.
    // Android 키보드가 compositionend를 먼저 보내 isComposing=false가 되어도 안전하다.
    return !eventLike.shiftKey && !eventLike.ctrlKey && !eventLike.altKey && !eventLike.metaKey;
}

export function resolvePendingInternalInputMatch(pending, message, chatRef, now = Date.now()) {
    if (!pending || !message?.is_user || !Array.isArray(chatRef)) {
        return { ok: false, chatChanged: false };
    }
    const freshEnough = Number(now) - Number(pending.createdAt || 0) < 120000;
    const samePayload = String(message.mes || '').trim() === String(pending.translatedText || '').trim();
    return {
        ok: freshEnough && samePayload,
        chatChanged: pending.chatRef !== chatRef
    };
}

export function shouldRestoreInternalInputDraft(currentValue, translatedText) {
    const current = String(currentValue || '').trim();
    return !current || current === String(translatedText || '').trim();
}

export function getInternalInputState(message) {
    const state = message?.extra?.cat_internal_input;
    if (!state || state.version !== 1) return null;
    const sourceText = String(state.sourceText || '');
    const translatedText = String(state.translatedText || '');
    if (!sourceText.trim() || !translatedText.trim()) return null;
    return {
        version: 1,
        sourceText,
        translatedText,
        targetLang: normalizeInternalInputLanguage(state.targetLang)
    };
}

export function applyInternalInputState(message, sourceText, translatedText, targetLang) {
    if (!message) return null;
    const source = String(sourceText || '').trim();
    const translated = String(translatedText || '').trim();
    if (!source || !translated) return null;
    if (!message.extra) message.extra = {};
    const state = {
        version: 1,
        sourceText: source,
        translatedText: translated,
        targetLang: normalizeInternalInputLanguage(targetLang)
    };
    message.extra.cat_internal_input = state;
    // 화면과 ✏️ 원문 편집에는 사용자가 쓴 한국어, 실제 AI 컨텍스트에는 번역문.
    message.extra.original_mes = source;
    message.extra.display_text = source;
    message.mes = translated;
    return state;
}

export function clearInternalInputState(message) {
    const state = getInternalInputState(message);
    if (!message || !state) return false;
    message.mes = state.sourceText;
    if (message.extra) {
        delete message.extra.cat_internal_input;
        delete message.extra.original_mes;
        delete message.extra.display_text;
        delete message.extra.cat_literal;
        delete message.extra.cat_prev_display;
        delete message.extra.cat_swipe_id;
    }
    return true;
}

export function detectLanguageDirection(text, settings) {
    // 🚨 언어 감지 전 메타 토큰 제거: ooc/rp/매크로 같은 영문 토큰이
    // "ooc: rp 중단하고 답변해" 같은 짧은 한국어 인풋의 비율을 왜곡하는 것 방지
    const analysis = analyzeLanguage(text);
    const korCount = analysis.chars.Korean;
    const engCount = analysis.chars.English;
    const jpCount = analysis.chars.Japanese;
    const cnCount = analysis.chars.Chinese;
    const total = korCount + engCount + jpCount + cnCount;

    if (total === 0) return { isToEnglish: false, targetLang: settings.targetLang };
    const korRatio = korCount / total; const engRatio = engCount / total;
    const jpRatio = jpCount / total; const cnRatio = cnCount / total;
    const bidir = settings.bidirectional || 'off';

    // 양방향 꺼짐 → 무조건 목표 언어로만
    if (bidir === 'off') {
        return { isToEnglish: false, targetLang: settings.targetLang };
    }

    // 한↔영
    if (bidir === 'ko-en') {
        if (isClearlyLanguage(analysis, 'Korean')) return { isToEnglish: true, targetLang: 'English' };
        if (isClearlyLanguage(analysis, 'English')) return { isToEnglish: false, targetLang: 'Korean' };
        // 🚨 혼합 텍스트 (둘 다 0.7 미달): 우세한 쪽을 원문으로 판정
        // 한글이 영문보다 많으면 한국어 원문 → 영어로, 반대면 영어 원문 → 한국어로
        if (korCount > 0 && korCount >= engCount) return { isToEnglish: true, targetLang: 'English' };
        if (engCount > korCount) return { isToEnglish: false, targetLang: 'Korean' };
    }

    // 한↔일
    if (bidir === 'ko-ja') {
        if (isClearlyLanguage(analysis, 'Korean')) return { isToEnglish: false, targetLang: 'Japanese' };
        if (isClearlyLanguage(analysis, 'Japanese', 0.6)) return { isToEnglish: false, targetLang: 'Korean' };
    }

    // 한↔중
    if (bidir === 'ko-zh') {
        if (isClearlyLanguage(analysis, 'Korean')) return { isToEnglish: false, targetLang: 'Chinese' };
        if (isClearlyLanguage(analysis, 'Chinese', 0.6)) return { isToEnglish: false, targetLang: 'Korean' };
    }

    return { isToEnglish: false, targetLang: settings.targetLang };
}

function parseDictionaryLine(line, isToEnglish = false) {
    if (!String(line || '').includes('=')) return null;
    const [left, ...rightParts] = String(line).split('=');
    const orig = left.trim();
    const trans = rightParts.join('=').trim();
    if (!orig || !trans) return null;
    return {
        originalLine: `${orig}=${trans}`,
        source: isToEnglish ? trans : orig,
        target: isToEnglish ? orig : trans
    };
}

function dictionaryTermRegex(term, flags = 'gi') {
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 영문 단어는 경계를 적용해 Ghost가 Ghostbusters 안에서 잡히지 않게 한다.
    const isLatinWord = /^[a-zA-Z]/.test(term) && /[a-zA-Z]$/.test(term);
    return new RegExp(isLatinWord ? `\\b${escaped}\\b` : escaped, flags);
}

// 현재 원문에 실제 등장한 항목만 반환한다. 프롬프트 필터·결과 강제 적용·품질 검사가
// 같은 경계 규칙을 공유해 includes() 계열의 부분 문자열 오탐이 다시 생기지 않게 한다.
export function getMatchedDictionaryLines(text, dictionary, isToEnglish = false) {
    if (!dictionary || !String(dictionary).trim()) return [];
    const source = String(text || '');
    return String(dictionary)
        .split('\n')
        .map(line => parseDictionaryLine(line, isToEnglish))
        .filter(Boolean)
        .filter(entry => dictionaryTermRegex(entry.source, 'i').test(source))
        .sort((a, b) => b.source.length - a.source.length)
        .map(entry => entry.originalLine);
}

export function applyPreReplace(text, dictionary, isToEnglish) { return applyPreReplaceWithCount(text, dictionary, isToEnglish).swapped; }
export function applyPreReplaceWithCount(text, dictionary, isToEnglish) {
    if (!dictionary || String(dictionary).trim() === "") return { swapped: text, matchCount: 0 };
    const entries = String(dictionary)
        .split('\n')
        .map(line => parseDictionaryLine(line, isToEnglish))
        .filter(Boolean)
        .sort((a, b) => b.source.length - a.source.length);
    if (entries.length === 0) return { swapped: text, matchCount: 0 };

    let result = text; let matchCount = 0;
    entries.forEach(({ source, target }) => {
        const regex = dictionaryTermRegex(source, 'gi');
        const matches = String(result).match(regex);
        if (matches) {
            matchCount += matches.length;
            result = String(result).replace(regex, target);
        }
    });
    return { swapped: result, matchCount };
}

export function normalizeText(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^a-z가-힣0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '').trim();
}

export function setTextareaValue(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeSetter) nativeSetter.call(el, value); else el.value = value;
    $(el).val(value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
}

// 🚨 캐릭터별 말투 패턴 분석 (정규식 기반, 비용 0)
export function analyzeSpeechPatterns(contextMessages) {
    if (!contextMessages || contextMessages.length === 0) return null;
    
    const speakerData = {};
    contextMessages.forEach(msg => {
        const speaker = msg.speaker || msg.name || 'Unknown';
        const text = msg.voiceText || msg.text || msg.mes || '';
        if (!text) return;
        
        if (!speakerData[speaker]) {
            speakerData[speaker] = { texts: [], totalLen: 0, hasKorean: 0, hasEnglish: 0, profanityCount: 0,
                shortSentences: 0, longSentences: 0, banmal: 0, jondaetmal: 0,
                scottishMarkers: 0, irishMarkers: 0, britishMarkers: 0, texanMarkers: 0 };
        }
        const d = speakerData[speaker];
        d.texts.push(text);
        d.totalLen += text.length;
        
        // 언어 감지
        if (/[가-힣]/.test(text)) d.hasKorean++;
        if (/[a-zA-Z]{3,}/.test(text)) d.hasEnglish++;
        
        // 욕설 감지 (한/영)
        if (/씨발|좆|개새끼|병신|fuck|shit|bitch|bastard|damn/gi.test(text)) d.profanityCount++;
        
        // 문장 길이 (대화만)
        const dialogues = text.match(/"[^"]+"/g) || [];
        dialogues.forEach(d_text => {
            const wordCount = d_text.split(/\s+/).length;
            if (wordCount < 8) speakerData[speaker].shortSentences++;
            else if (wordCount > 20) speakerData[speaker].longSentences++;
        });
        
        // 한국어 어미 (반말/존댓말) - 정확한 패턴만 매칭
        // 반말: -야, -어, -지, -다 + 종결 (단 -다음 같은 것 제외)
        const speechText = dialogues.length > 0 ? dialogues.join(' ') : text;
        const banmalEndings = (speechText.match(/[다어야지네군](?=[.!?\s"」』]|$)/g) || []).length;
        const jondaetmalEndings = (speechText.match(/요(?=[.!?\s"」』]|$)|습니다|입니다|시오|십시오|세요/g) || []).length;
        // 반말이 존댓말로 오탐되는 케이스 보정
        const correctedBanmal = Math.max(0, banmalEndings - jondaetmalEndings);
        d.banmal += correctedBanmal;
        d.jondaetmal += jondaetmalEndings;
        
        // 영어 사투리 마커
        if (/\b(aye|lass|laddie|wee|bonnie|bairn|cannae|dinnae|wouldnae)\b/gi.test(text)) d.scottishMarkers++;
        if (/\b(begorrah|wee|grand|craic|after.*ing|tis|sure and)\b/gi.test(text)) d.irishMarkers++;
        if (/\b(bloody|bloke|blimey|innit|cheers mate|brilliant|reckon)\b/gi.test(text)) d.britishMarkers++;
        if (/\b(y'all|reckon|fixin'|ain't|howdy|partner|yonder)\b/gi.test(text)) d.texanMarkers++;
    });
    
    // 패턴 요약 생성
    const patterns = [];
    Object.entries(speakerData).forEach(([speaker, d]) => {
        if (d.texts.length === 0) return;
        const traits = [];
        const avgLen = d.totalLen / d.texts.length;
        
        // 언어
        if (d.hasKorean > 0 && d.hasEnglish > 0) traits.push('mixed Korean/English');
        else if (d.hasKorean > d.hasEnglish) traits.push('primarily Korean');
        else traits.push('primarily English');
        
        // 사투리 마커
        if (d.scottishMarkers > 0) traits.push('Scottish dialect markers (aye/lass/wee)');
        if (d.irishMarkers > 0) traits.push('Irish dialect markers');
        if (d.britishMarkers > 0) traits.push('British slang (bloody/bloke)');
        if (d.texanMarkers > 0) traits.push('Texan/Southern markers');
        
        // 문장 스타일
        if (d.shortSentences > d.longSentences * 2) traits.push('terse/short sentences');
        else if (d.longSentences > d.shortSentences * 2) traits.push('elaborate/long sentences');
        
        // 욕설
        if (d.profanityCount > 0) traits.push(`uses profanity (${d.profanityCount}x)`);
        
        // 한국어 어미
        if (d.hasKorean > 0) {
            if (d.banmal > d.jondaetmal * 2) traits.push('Korean: 반말 (informal)');
            else if (d.jondaetmal > d.banmal * 2) traits.push('Korean: 존댓말 (formal)');
            else if (d.banmal > 0 || d.jondaetmal > 0) traits.push('Korean: mixed formality');
        }
        
        if (traits.length > 0) patterns.push(`- ${speaker}: ${traits.join(', ')}`);
    });
    
    return patterns.length > 0 ? patterns.join('\n') : null;
}

// ============================================================
// 🔍 직역 병기 (Literal Appendix) 헬퍼
// ============================================================

// AI 출력에서 자연번역 / 직역 파트 분리
// 마커가 없으면 { natural: 전체, literal: null } — 우아한 실패
export function splitLiteralAppendix(text) {
    if (!text) return { natural: text, literal: null };
    const markerRe = /\n?\s*<{2,3}\s*CAT_LITERAL\s*>{2,3}\s*\n?/i;
    const m = text.match(markerRe);
    if (!m) return { natural: text, literal: null };
    const idx = m.index;
    const natural = text.slice(0, idx).trim();
    const literal = text.slice(idx + m[0].length).trim();
    // 직역 파트가 비어있으면 (토큰 잘림 등) 자연번역만
    if (!literal) return { natural, literal: null };
    // 자연번역 파트에 마커 잔재가 또 있으면 제거 (모델 이중 출력 방어)
    return { natural: natural.replace(markerRe, '').trim(), literal };
}

// 직역 텍스트 → 접이식 <details> HTML (ST 네이티브 렌더, 탭 이벤트 JS 불필요)
// 직역 파트가 "» 원문 / 직역" 교차 짝 형식이면 줄 단위 스타일링으로 번갈아 표시
// 형식이 아니면(모델이 무시) originalText로 기존 2블럭(원문 통짜+직역 통짜) 폴백
export function buildLiteralDetailsHtml(literalText, originalText = null) {
    const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const lines = String(literalText).split('\n');
    const hasPairs = lines.some(l => /^»\s?/.test(l.trim()));
    
    if (hasPairs) {
        // 교차 짝 렌더 — 네이티브 태그 구조 (p=짝 간격, em=원문 이탤릭, br=짝 내부 줄바꿈)
        // ST 새니타이저가 class를 벗기거나 CSS가 캐시돼도 브라우저 기본 스타일로 간격·구분 유지됨
        const pairs = [];
        let cur = null;
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            const m = t.match(/^»\s?(.*)$/);
            if (m) {
                if (cur) pairs.push(cur);
                cur = { orig: m[1], lit: [] };
            } else if (cur) {
                cur.lit.push(t);
            } else {
                // » 앞에 떠도는 줄 → 자체 짝으로 (원문 없이)
                pairs.push({ orig: null, lit: [t] });
            }
        }
        if (cur) pairs.push(cur);
        const body = pairs.map(p => {
            const litHtml = p.lit.map(escapeHtml).join('<br>');
            if (p.orig !== null) {
                return `<p class="cat-literal-pair"><em class="cat-literal-orig">${escapeHtml(p.orig)}</em><br>${litHtml}</p>`;
            }
            return `<p class="cat-literal-pair">${litHtml}</p>`;
        }).join('');
        return `<details class="cat-literal"><summary>🔍 원문·직역 보기</summary><div class="cat-literal-body">${body}</div></details>`;
    }
    
    // 폴백: 짝 형식 아님 → 원문 통짜 + 직역 통짜 2블럭
    const litHtml = escapeHtml(literalText).replace(/\n/g, '<br>');
    if (originalText) {
        const origHtml = escapeHtml(originalText).replace(/\n/g, '<br>');
        return `<details class="cat-literal"><summary>🔍 원문·직역 보기</summary><div class="cat-literal-body"><div class="cat-literal-label">📜 원문</div><div class="cat-literal-orig">${origHtml}</div><div class="cat-literal-label">🔍 직역</div><div>${litHtml}</div></div></details>`;
    }
    return `<details class="cat-literal"><summary>🔍 직역 보기</summary><div class="cat-literal-body">${litHtml}</div></details>`;
}

// display_text에서 직역 details 블록 제거 (재번역 prevTranslation 오염 방지용)
export function stripLiteralDetails(text) {
    if (!text) return text;
    return text.replace(/\s*<details class="cat-literal">[\s\S]*?<\/details>\s*/g, '').trim();
}
