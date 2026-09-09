// One translation owns one budget, including transport and validation retries.
export function createRequestState(fast, signal = null, log = {}) {
    return { startedAt: Date.now(), deadline: Date.now() + (fast ? 180000 : 300000),
        maxCalls: fast ? 2 : 3, calls: 0, signal, log, timings: [] };
}

export function canRequest(state) {
    return !state.signal?.aborted && state.calls < state.maxCalls && Date.now() < state.deadline;
}

function cancelled() { return Object.assign(new Error('취소됨'), { name: 'AbortError' }); }
function timedOut() {
    return Object.assign(new Error('⏱️ [응답 시간 초과] 번역 대기를 종료했어요. 원문을 유지합니다. 서버가 취소를 지원하지 않으면 서버 처리는 계속될 수 있어요.'), { name: 'TimeoutError' });
}

// Keep the deadline active through response-body parsing. Also settle locally if
// an older connector ignores signal; a timeout is terminal, never an orphan retry.
export async function runRequest(state, factory, timeoutMs, metadata = {}) {
    if (state.signal?.aborted) throw cancelled();
    if (Date.now() >= state.deadline) throw timedOut();
    if (state.calls >= state.maxCalls) throw new Error('⚠️ [재시도 한도] 이번 번역의 API 호출 한도에 도달했어요.');
    state.calls++;
    const controller = new AbortController();
    const timing = { attempt: state.calls, startedAt: Date.now(), ...metadata };
    state.timings.push(timing);
    let timer, abortHandler;
    try {
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
            abortHandler = () => { controller.abort(); finish(reject, cancelled()); };
            state.signal?.addEventListener('abort', abortHandler, { once: true });
            timer = setTimeout(() => { controller.abort(); finish(reject, timedOut()); },
                Math.max(1, Math.min(timeoutMs, state.deadline - Date.now())));
            if (state.signal?.aborted) { abortHandler(); return; }
            Promise.resolve().then(() => {
                if (settled) throw cancelled();
                return factory(controller.signal);
            }).then(value => { if (!settled) { timing.status = 'received'; finish(resolve, value); } },
                error => { finish(reject, error); });
        });
    } catch (error) {
        timing.status = error.name || 'Error';
        throw error;
    } finally {
        clearTimeout(timer);
        state.signal?.removeEventListener('abort', abortHandler);
        timing.elapsedMs = Date.now() - timing.startedAt;
    }
}

export function waitForRetry(ms, signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(done, ms);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
