import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { getSidecarUrl, createBoard, listBoards, getBoard, putBoard } from '../lib/tauri';
import { renderMarkdown, notesToNodes } from '../lib/markdown';
import { getAiCfg, getAskNotes } from '../lib/ai';
import type { Board, BoardNode } from '../lib/types';

interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}
interface ChatMsg {
  role: string;
  content: string;
}
interface Turn {
  speaker: string;
  text: string;
}

const PIPELINE = ['Loading model', 'Preparing audio', 'Transcribing', 'Aligning words', 'Identifying speakers', 'Writing notes'];
const CHIPS = [
  { label: 'Summary', prompt: 'Give me a concise summary of this recording.' },
  { label: 'Action items', prompt: 'List the action items.' },
  { label: 'Decisions', prompt: 'What decisions were made?' },
  { label: 'Key points', prompt: 'Key points by speaker.' },
];

function newId() {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function fmtTime(s: number) {
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function stepIndexFor(stage: string) {
  const first = (stage || '').split(' ')[0].toLowerCase();
  return PIPELINE.findIndex((s) => s.toLowerCase().startsWith(first));
}

export function Capture({ onOpenBoard, onBoardCreated }: { onOpenBoard: (boardId: string) => void; onBoardCreated?: () => void }) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [statusText, setStatusText] = useState('Idle — press to start');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [notes, setNotes] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [chats, setChats] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [busyChat, setBusyChat] = useState(false);
  const [showBoardPrompt, setShowBoardPrompt] = useState(false);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardSel, setBoardSel] = useState('');
  const [sending, setSending] = useState(false);
  const [sentInfo, setSentInfo] = useState<{ count: number; boardId: string } | null>(null);
  const [notePickOpen, setNotePickOpen] = useState(false);
  const [noteModels, setNoteModels] = useState<{ name: string; size: number }[]>([]);
  const [notePickSel, setNotePickSel] = useState('');
  const [notePicking, setNotePicking] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  // Merge consecutive same-speaker segments into turns (like the old app).
  const turns = useMemo<Turn[]>(() => {
    const out: Turn[] = [];
    for (const seg of segments) {
      const last = out[out.length - 1];
      if (last && last.speaker === seg.speaker) last.text += ' ' + seg.text;
      else out.push({ speaker: seg.speaker, text: seg.text });
    }
    return out;
  }, [segments]);

  const stopStreams = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
  }, []);

  const startRecording = useCallback(async () => {
    if (transcribing) return;
    setError('');
    setStatusText('Requesting microphone…');
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatusText('Microphone access was blocked.');
      setError('Microphone access was blocked. Allow it to record.');
      return;
    }

    // System audio is mixed in when enabled in Settings (default on), like the old app.
    let desktopStream: MediaStream | null = null;
    if (localStorage.getItem('nt-set-setSystem') !== 'false') {
      try {
        desktopStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!desktopStream.getAudioTracks().length) {
          desktopStream.getTracks().forEach((t) => t.stop());
          desktopStream = null;
          setStatusText('No system audio captured — recording mic only.');
        }
      } catch {
        desktopStream = null;
      }
    }

    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaStreamSource(micStream).connect(dest);
    if (desktopStream) audioCtx.createMediaStreamSource(desktopStream).connect(dest);
    audioCtxRef.current = audioCtx;
    streamRef.current = dest.stream;

    chunksRef.current = [];
    const mr = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      stopStreams();
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (blob.size === 0) { setStatusText('Recording was empty.'); setError('Recording was empty.'); return; }
      transcribe(blob, 'recording.webm');
    };
    mr.start();
    mediaRecorderRef.current = mr;
    if (desktopStream) {
      desktopStream.getVideoTracks().forEach((t) => {
        t.onended = () => { if (mediaRecorderRef.current?.state === 'recording') stopRecording(); };
      });
    }
    setRecording(true);
    setElapsed(0);
    startTimeRef.current = Date.now();
    setStatusText('Recording — press stop to transcribe.');
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  }, [transcribing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const transcribe = useCallback(async (blob: Blob, filename: string) => {
    if (transcribing) return;
    setTranscribing(true);
    setError('');
    setProgress(2);
    setStage('Loading model');
    setSegments([]);
    setNotes('');
    setTranscript('');
    setSentInfo(null);
    setShowBoardPrompt(false);
    setStatusText('Transcribing locally… models load on first use.');

    try {
      const baseUrl = await getSidecarUrl();
      const cfg = getAiCfg();
      const form = new FormData();
      form.append('file', blob, filename);
      form.append('provider', cfg.provider);
      form.append('api_base', cfg.api_base);
      form.append('api_key', cfg.api_key);
      form.append('stt_model', cfg.stt_model);
      form.append('llm_model', cfg.llm_model);
      form.append('notes_mode', getAskNotes() && cfg.provider === 'local' ? 'ask' : 'auto');
      const res = await fetch(`${baseUrl}/api/transcribe`, { method: 'POST', body: form });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || `Failed (${res.status})`);
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result: any = null;

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === 'progress') {
            setProgress(evt.pct);
            setStage(evt.stage);
          } else if (evt.type === 'result') {
            result = evt;
            setProgress(100);
          } else if (evt.type === 'error') {
            throw new Error(evt.detail);
          }
        }
      }

      if (!result) throw new Error('Transcription ended without a result.');

      setTranscript(result.transcript || '');
      setSegments(result.segments || []);
      if (result.notes === null || result.notes === undefined) {
        openNotePicker();
      } else {
        setNotes(result.notes || '');
        if (result.warning) {
          setStatusText('Done · ⚠ ' + result.warning);
        } else {
          setStatusText('Transcription complete.');
        }
        if (result.notes && result.notes.trim()) {
          setShowBoardPrompt(true);
          listBoards().then(setBoards).catch(() => {});
        }
      }
    } catch (err: any) {
      setStatusText('');
      setError(err.message);
    } finally {
      setTranscribing(false);
      setStage('');
      setProgress(0);
    }
  }, [transcribing]);

  const sendChat = useCallback(async (text: string) => {
    const prompt = (text || '').trim();
    if (!prompt || busyChat || !transcript) return;
    const userMsg: ChatMsg = { role: 'user', content: prompt };
    const history = [...chats, userMsg];
    setChats(history);
    setChatDraft('');
    setBusyChat(true);
    try {
      const baseUrl = await getSidecarUrl();
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, messages: history, cfg: getAiCfg() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Failed (${res.status})`);
      setChats([...history, { role: 'assistant', content: data.reply || '' }]);
    } catch (err: any) {
      setChats([...history, { role: 'assistant', content: '⚠ ' + err.message }]);
    } finally {
      setBusyChat(false);
    }
  }, [chats, busyChat, transcript]);

  const openNotePicker = useCallback(async () => {
    setError('');
    try {
      const baseUrl = await getSidecarUrl();
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) {
        const s = await res.json();
        const models: { name: string; size: number }[] = (s.ollama_models || []).map(
          (n: string) => ({ name: n, size: (s.ollama_sizes || {})[n] || 0 })
        );
        if (models.length) {
          const cfg = getAiCfg();
          setNoteModels(models);
          setNotePickSel(
            models.some((m) => m.name === cfg.llm_model) ? cfg.llm_model : (s.ollama_smallest || models[0].name)
          );
          setNotePickOpen(true);
          return;
        }
      }
      setStatusText('Transcription complete.');
    } catch {
      setStatusText('Transcription complete.');
    }
  }, []);

  const generateNotes = useCallback(async (model: string) => {
    if (!transcript || notePicking || !model) return;
    setNotePicking(true);
    try {
      const baseUrl = await getSidecarUrl();
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          messages: [],
          cfg: { ...getAiCfg(), llm_model: model },
          notes: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Failed (${res.status})`);
      setNotes(data.reply || '');
      setStatusText('Notes generated.');
      setShowBoardPrompt(true);
      listBoards().then(setBoards).catch(() => {});
    } catch (err: any) {
      setError(err.message);
    } finally {
      setNotePicking(false);
      setNotePickOpen(false);
    }
  }, [transcript, notePicking]);

  const sendToBoard = useCallback(async (boardId: string) => {
    if (sending) return;
    const drafts = notesToNodes(notes);
    if (!drafts.length) { setError('Could not split the notes into board nodes.'); return; }
    setSending(true);
    try {
      let target = boardId;
      const sourceTitle = transcript.split('\n')[0]?.replace(/^Speaker \d+:\s*/, '').slice(0, 60) || 'Untitled recording';
      const sourceTag = sourceTitle.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24);
      if (!target) {
        const board = await createBoard(sourceTitle);
        target = board.id;
      }
      const existing = await getBoard(target);
      const allNodes: BoardNode[] = [
        ...existing.nodes,
        ...drafts.map((d) => ({
          ...d,
          id: newId(),
          tags: [d.tag, sourceTag].filter((t): t is string => !!t),
        })),
      ];
      const edgesPayload = existing.edges.map((e) => ({
        id: e.id, from: e.fromId, to: e.toId, color: e.color, label: e.label,
      }));
      await putBoard(target, allNodes, edgesPayload);
      setShowBoardPrompt(false);
      setSentInfo({ count: drafts.length, boardId: target });
      if (!boardId && onBoardCreated) onBoardCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }, [notes, transcript, sending, onBoardCreated]);

  const pipeIndex = stepIndexFor(stage);
  const chatReady = !!transcript;

  return (
    <div className="rec-layout">
      <section className="rec-col">

        <div className="card rec-stage-card">
          <div className="card-head">
            <span className="eyebrow">Capture</span>
            <span className="grow" />
            <span className="status-pill"><span className="dot" /> local · private</span>
          </div>
          <p className="rec-desc">Record a meeting or a voice memo. Nothing leaves this machine — transcription runs locally, only when you ask.</p>

          <div className="rec-btns">
            <div className="rec-btn-wrap">
              <button
                className={`rec-btn ${recording ? 'recording' : ''}`}
                onClick={recording ? stopRecording : startRecording}
                disabled={transcribing}
                aria-label={recording ? 'Stop recording' : 'Record'}
              >
                {recording ? (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
                ) : (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9" /></svg>
                )}
              </button>
              <div>
                <div className="rec-timer">{recording || transcribing ? fmtTime(elapsed) : '00:00'}</div>
                <div className="hint" style={{ marginTop: 8 }}>{statusText}</div>
              </div>
            </div>
          </div>

          {transcribing && (
            <div className="pipe-wrap">
              <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
              <div className="pipeline">
                {PIPELINE.map((s, i) => (
                  <div key={s} className={`pipe-step ${i < pipeIndex ? 'done' : i === pipeIndex ? 'running' : ''}`}>
                    <span className="pipe-ico">
                      {i < pipeIndex ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="8" /></svg>
                      )}
                    </span>
                    <span className="pipe-name">{s}</span>
                    <span className="pipe-meta">{i === pipeIndex ? `${progress}%` : ''}</span>
                  </div>
                ))}
              </div>
              <div className="pipe-note">whisper model loads on first transcription, then stays warm</div>
            </div>
          )}

          <div className="file-pick">
            <div className="hint" style={{ marginBottom: 8 }}>Or import audio</div>
            <label className="file-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
              <input
                ref={fileInputRef}
                type="file"
                accept=".mp3,.mp4,.m4a,.wav,.mov,.webm"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setFileName(f.name); transcribe(f, f.name); e.target.value = ''; }
                }}
              />
              <span>{fileName || 'Choose file — mp3, wav, m4a, webm, mp4, mov'}</span>
            </label>
          </div>
        </div>

        <div className="card transcript-card">
          <div className="card-head">
            <span className="eyebrow">Transcript</span>
            <span className="grow" />
            <span className="hint">
              {(() => { const n = segments.length ? new Set(segments.map((s) => s.speaker).filter(Boolean)).size : 0; return n ? `${n} speaker${n === 1 ? '' : 's'}` : '—'; })()}
            </span>
          </div>
          <div className="transcript-scroll">
            {turns.length === 0 ? (
              <div className="ai-empty">Record or import audio — the transcript appears here once you run it through transcription.</div>
            ) : (
              turns.map((t, i) => {
                const m = /Speaker (\d+)/.exec(t.speaker);
                const n = m ? parseInt(m[1], 10) : 1;
                return (
                  <div key={i} className={`turn sp-${((n - 1) % 5) + 1}`}>
                    <div className="who">{t.speaker}</div>
                    <div className="what">{t.text}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {error && <div className="error-msg">{error}</div>}

      </section>

      <section className="rec-side">
        <div className="card ai-card">
          <div className="ai-head">
            <span className="tag is-patina"><span className="dot" /> AI · optional</span>
            <span className="grow" />
            <span className="hint">on demand</span>
          </div>

          <div className="ai-summary">
            {showBoardPrompt && (
              <div className="board-prompt">
                <span>Send notes to a board?</span>
                <button className="btn btn-primary btn-sm" onClick={() => sendToBoard('')} disabled={sending}>
                  New board
                </button>
                {boards.length > 0 && (
                  <>
                    <select className="select" style={{ width: 'auto', height: 30, fontSize: '0.78rem' }} value={boardSel} onChange={(e) => setBoardSel(e.target.value)}>
                      <option value="">Add to board…</option>
                      {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    <button className="btn btn-secondary btn-sm" onClick={() => boardSel && sendToBoard(boardSel)} disabled={sending || !boardSel}>
                      Add
                    </button>
                  </>
                )}
              </div>
            )}

            {notePickOpen && (
              <div className="board-prompt">
                <span>Generate notes with which model?</span>
                <select
                  className="select" style={{ width: 'auto', height: 30, fontSize: '0.78rem' }}
                  value={notePickSel}
                  onChange={(e) => setNotePickSel(e.target.value)}
                >
                  {noteModels.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}{m.size ? ` · ${(m.size / 1e9).toFixed(1)} GB` : ''}
                    </option>
                  ))}
                </select>
                <button className="btn btn-primary btn-sm" onClick={() => generateNotes(notePickSel)} disabled={notePicking || !notePickSel}>
                  Generate
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setNotePickOpen(false)} disabled={notePicking}>
                  Skip
                </button>
              </div>
            )}

            {sentInfo && (
              <div className="board-prompt">
                <span className="board-ok">✓ Sent {sentInfo.count} notes to board.</span>
                <span className="open-link" onClick={() => onOpenBoard(sentInfo.boardId)}>Open board →</span>
              </div>
            )}

            {notes ? (
              <div className="notes" dangerouslySetInnerHTML={{ __html: renderMarkdown(notes) }} />
            ) : (
              <p className="ai-empty" style={{ marginTop: 12 }}>Summary, action items, and a chat over the transcript will appear here after transcription.</p>
            )}
          </div>

          <hr className="seam" />

          <div className="chat-wrap">
            <div className="chip-row">
              {CHIPS.map((c) => (
                <button key={c.label} className="chip" disabled={!chatReady || busyChat} onClick={() => sendChat(c.prompt)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="chat-scroll" ref={chatScrollRef}>
              {chats.length === 0 ? (
                <div className="ai-empty">{chatReady ? 'Ready — ask anything about this recording.' : 'Chat over the transcript — transcribe first.'}</div>
              ) : (
                chats.map((m, i) => (
                  m.role === 'user' ? (
                    <div key={i} className="msg user">{m.content}</div>
                  ) : (
                    <div key={i} className="msg bot">
                      <span className="msg-role">Note taker</span>
                      <span dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                    </div>
                  )
                ))
              )}
              {busyChat && (
                <div className="msg bot"><span className="msg-role">Note taker</span>…</div>
              )}
            </div>
            <div className="chat-input-row">
              <input
                className="input"
                placeholder={chatReady ? 'Ask about the recording…' : 'Transcribe first to enable chat.'}
                value={chatDraft}
                disabled={!chatReady || busyChat}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendChat(chatDraft); }}
              />
              <button className="btn btn-primary" disabled={!chatReady || busyChat} onClick={() => sendChat(chatDraft)} aria-label="Send">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
