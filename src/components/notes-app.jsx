"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readDraggedUrl } from "./drop-utils.mjs";
import { editorToMarkdown, noteToDelta } from "./markdown-codec";

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function requestApi(url, { csrfToken, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrfToken && options.method && options.method !== "GET") {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      data.message || "Não foi possível concluir a operação.",
      response.status,
      data.error
    );
  }
  return data;
}

function Message({ value }) {
  if (!value) return null;
  return (
    <div className={`message${value.success ? " success" : ""}`} role="alert">
      {value.text}
    </div>
  );
}

export default function NotesApp() {
  const [screen, setScreen] = useState("loading");
  const [message, setMessage] = useState(null);
  const [vaultMessage, setVaultMessage] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [user, setUser] = useState(null);
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [idleTimeoutMs, setIdleTimeoutMs] = useState(15 * 60 * 1000);
  const [saveStatus, setSaveStatus] = useState("Salvo");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const editorElement = useRef(null);
  const editorPane = useRef(null);
  const fileInput = useRef(null);
  const quill = useRef(null);
  const loadingEditor = useRef(false);
  const saveTimer = useRef(null);
  const saving = useRef(false);
  const pendingSave = useRef(false);
  const locking = useRef(false);
  const lockActionRef = useRef(null);
  const notesRef = useRef(notes);
  const selectedIdRef = useRef(selectedId);
  const csrfRef = useRef(csrfToken);
  const saveCurrentRef = useRef(null);
  const selected = notes.find((note) => note.id === selectedId) || null;

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { csrfRef.current = csrfToken; }, [csrfToken]);

  const handleLocked = useCallback((text = "A sessão foi bloqueada. Informe a senha novamente.") => {
    setCsrfToken("");
    setUser(null);
    setNotes([]);
    setSelectedId(null);
    setCollapsedIds(new Set());
    setAttachments([]);
    setScreen("login");
    setMessage({ text });
  }, []);

  const loadNotes = useCallback(async (preferredId) => {
    const result = await requestApi("/api/notes");
    setNotes(result.notes);
    setSelectedId(
      preferredId && result.notes.some((note) => note.id === preferredId)
        ? preferredId
        : result.notes[0]?.id || null
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestApi("/api/status")
      .then(async (status) => {
        if (cancelled) return;
        if (Number.isFinite(status.idleTimeoutMs)) {
          setIdleTimeoutMs(status.idleTimeoutMs);
        }
        if (status.authenticated) {
          setCsrfToken(status.csrfToken);
          setUser(status.user);
          setScreen("vault");
          await loadNotes();
        } else {
          setScreen("login");
        }
      })
      .catch((error) => setMessage({ text: error.message }));
    return () => { cancelled = true; };
  }, [loadNotes]);

  const saveCurrent = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const note = notesRef.current.find((item) => item.id === selectedIdRef.current);
    if (!note || !quill.current) return;
    if (saving.current) {
      pendingSave.current = true;
      return;
    }
    saving.current = true;
    setSaveStatus("Salvando…");
    const snapshot = {
      id: note.id,
      title: note.title.trim() || "Sem título",
      markdown: editorToMarkdown(quill.current),
      parentId: note.parentId || null,
      revision: note.revision
    };
    try {
      const result = await requestApi(`/api/notes/${snapshot.id}`, {
        method: "PATCH",
        csrfToken: csrfRef.current,
        body: snapshot
      });
      setNotes((current) =>
        current.map((item) =>
          item.id === snapshot.id ? { ...item, ...result.note } : item
        )
      );
      setSaveStatus("Salvo");
    } catch (error) {
      setSaveStatus("Erro ao salvar");
      if (error.status === 401) handleLocked();
      else if (error.status === 409) {
        setVaultMessage({ text: "A nota mudou em outra sessão. A lista foi recarregada." });
        await loadNotes(snapshot.id);
      } else {
        setVaultMessage({ text: error.message });
      }
    } finally {
      saving.current = false;
      if (pendingSave.current) {
        pendingSave.current = false;
        void saveCurrentRef.current?.();
      }
    }
  }, [handleLocked, loadNotes]);
  saveCurrentRef.current = saveCurrent;

  const queueSave = useCallback(() => {
    if (loadingEditor.current || !selectedIdRef.current) return;
    setSaveStatus("Alterações pendentes");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveCurrentRef.current?.(), 800);
  }, []);

  useEffect(() => {
    if (screen !== "vault" || !editorElement.current || quill.current) return;
    let cancelled = false;
    import("quill").then(({ default: Quill }) => {
      if (cancelled || !editorElement.current || quill.current) return;
      quill.current = new Quill(editorElement.current, {
        theme: "snow",
        modules: {
          toolbar: [
            [{ header: [1, 2, 3, false] }],
            ["bold", "italic", "underline", "strike"],
            [{ list: "ordered" }, { list: "bullet" }],
            ["blockquote", "code-block", "link"],
            ["clean"]
          ]
        }
      });
      quill.current.on("text-change", queueSave);
      const note = notesRef.current.find((item) => item.id === selectedIdRef.current);
      if (note) quill.current.setContents(noteToDelta(quill.current, note), "silent");
    });
    return () => {
      cancelled = true;
      if (quill.current) quill.current.off("text-change", queueSave);
      quill.current = null;
    };
  }, [queueSave, screen]);

  useEffect(() => {
    const note = notesRef.current.find((item) => item.id === selectedId);
    if (!note || !quill.current) return;
    editorPane.current?.scrollTo({ top: 0 });
    loadingEditor.current = true;
    quill.current.setContents(noteToDelta(quill.current, note), "silent");
    loadingEditor.current = false;
    setSaveStatus("Salvo");
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    setAttachments([]);
    if (!selectedId || screen !== "vault") return () => { cancelled = true; };
    requestApi(`/api/notes/${selectedId}/attachments`)
      .then((result) => {
        if (!cancelled) setAttachments(result.attachments);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error.status === 401) handleLocked();
        else setVaultMessage({ text: error.message });
      });
    return () => { cancelled = true; };
  }, [handleLocked, screen, selectedId]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  async function flushSave() {
    if (saveTimer.current) await saveCurrentRef.current?.();
    while (saving.current) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  async function authenticate(event, endpoint) {
    event.preventDefault();
    setMessage(null);
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (values.confirmation !== undefined && values.password !== values.confirmation) {
      setMessage({ text: "A confirmação da senha não confere." });
      return;
    }
    const body = { username: values.username, password: values.password };
    try {
      const result = await requestApi(endpoint, { method: "POST", body });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      setScreen("vault");
      form.reset();
      if (endpoint === "/api/register") history.replaceState(null, "", "/");
      const status = await requestApi("/api/status");
      if (Number.isFinite(status.idleTimeoutMs)) {
        setIdleTimeoutMs(status.idleTimeoutMs);
      }
      await loadNotes();
    } catch (error) {
      setMessage({ text: error.message });
    }
  }

  async function createNote(parentId = null) {
    setVaultMessage(null);
    await flushSave();
    try {
      const result = await requestApi("/api/notes", {
        method: "POST",
        csrfToken,
        body: { title: "Nova página", markdown: "", parentId }
      });
      setNotes((current) => [result.note, ...current]);
      if (parentId) {
        setCollapsedIds((current) => {
          const next = new Set(current);
          next.delete(parentId);
          return next;
        });
      }
      setSelectedId(result.note.id);
    } catch (error) {
      if (error.status === 401) handleLocked();
      else setVaultMessage({ text: error.message });
    }
  }

  async function deleteNote() {
    if (!selected) return;
    const descendants = collectDescendantIds(notes, selected.id);
    const detail = descendants.size > 0
      ? ` e suas ${descendants.size} subpágina(s)`
      : "";
    if (!confirm(`Excluir definitivamente “${selected.title}”${detail}?`)) return;
    try {
      await requestApi(`/api/notes/${selected.id}`, {
        method: "DELETE",
        csrfToken
      });
      const removed = new Set([selected.id, ...descendants]);
      const remaining = notes.filter((note) => !removed.has(note.id));
      setNotes(remaining);
      setSelectedId(remaining[0]?.id || null);
    } catch (error) {
      if (error.status === 401) handleLocked();
      else setVaultMessage({ text: error.message });
    }
  }

  function moveSelected(parentId) {
    if (!selected) return;
    setNotes((current) => current.map((note) =>
      note.id === selected.id ? { ...note, parentId: parentId || null } : note
    ));
    if (parentId) {
      setCollapsedIds((current) => {
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
    queueSave();
  }

  async function uploadFiles(files) {
    if (!selected || !quill.current || files.length === 0) return;
    setUploading(true);
    setVaultMessage(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch(`/api/notes/${selected.id}/attachments`, {
          method: "POST",
          headers: { "X-CSRF-Token": csrfRef.current },
          body: form
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new ApiError(
            result.message || "Não foi possível enviar o anexo.",
            response.status,
            result.error
          );
        }

        const attachment = result.attachment;
        const range = quill.current.getSelection(true) || {
          index: Math.max(0, quill.current.getLength() - 1),
          length: 0
        };
        if (attachment.isImage) {
          quill.current.insertEmbed(range.index, "image", attachment.url, "user");
          quill.current.insertText(range.index + 1, "\n", "user");
        } else {
          const label = `📎 ${attachment.name}`;
          quill.current.insertText(
            range.index,
            label,
            { link: attachment.url },
            "user"
          );
          quill.current.insertText(range.index + label.length, "\n", "user");
        }
        setAttachments((current) => [...current, attachment]);
      }
      await saveCurrentRef.current?.();
      setVaultMessage({ text: "Anexo criptografado e inserido na nota.", success: true });
    } catch (error) {
      if (error.status === 401) handleLocked();
      else setVaultMessage({ text: error.message });
    } finally {
      setUploading(false);
    }
  }

  async function handleEditorDrop(event) {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length > 0) {
      await uploadFiles(files);
      return;
    }

    const url = readDraggedUrl(event.dataTransfer);
    if (!url || !quill.current) {
      setVaultMessage({
        text: "O item arrastado não contém um link HTTP/HTTPS ou um arquivo válido."
      });
      return;
    }

    const editor = quill.current;
    const range = editor.getSelection(true) || {
      index: Math.max(0, editor.getLength() - 1),
      length: 0
    };
    editor.insertText(range.index, url, { link: url }, "user");
    editor.insertText(range.index + url.length, "\n", "user");
    await saveCurrentRef.current?.();
    setVaultMessage({
      text: "Link inserido e salvo dentro do conteúdo criptografado.",
      success: true
    });
  }

  async function deleteAttachment(attachment) {
    if (!confirm(`Excluir definitivamente o anexo “${attachment.name}”?`)) return;
    try {
      await requestApi(`/api/attachments/${attachment.id}`, {
        method: "DELETE",
        csrfToken
      });
      const editor = quill.current;
      if (editor) {
        const ranges = [];
        let index = 0;
        for (const operation of editor.getContents().ops || []) {
          const length = typeof operation.insert === "string"
            ? operation.insert.length
            : 1;
          const image = operation.insert?.image;
          const link = operation.attributes?.link;
          const attachmentPath = `/api/attachments/${attachment.id}`;
          if (
            (typeof image === "string" && image.includes(attachmentPath)) ||
            (typeof link === "string" && link.includes(attachmentPath))
          ) {
            ranges.push({ index, length });
          }
          index += length;
        }
        for (const range of ranges.reverse()) {
          editor.deleteText(range.index, range.length, "user");
        }
      }
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      await saveCurrentRef.current?.();
    } catch (error) {
      if (error.status === 401) handleLocked();
      else setVaultMessage({ text: error.message });
    }
  }

  async function lock({ inactive = false } = {}) {
    if (locking.current) return;
    locking.current = true;
    await flushSave();
    try {
      await requestApi("/api/lock", { method: "POST", csrfToken, body: {} });
    } finally {
      locking.current = false;
      handleLocked(
        inactive
          ? `Cofre bloqueado após ${formatIdleDuration(idleTimeoutMs)} sem atividade. Informe a senha novamente.`
          : undefined
      );
    }
  }
  lockActionRef.current = lock;

  useEffect(() => {
    if (screen !== "vault") return;

    let lastActivity = Date.now();
    let lastPointerSignal = 0;
    let idleTimer;
    const heartbeatMs = Math.max(1000, Math.min(60 * 1000, idleTimeoutMs / 3));

    const checkIdle = () => {
      const remaining = idleTimeoutMs - (Date.now() - lastActivity);
      if (remaining <= 0) {
        void lockActionRef.current?.({ inactive: true });
        return;
      }
      idleTimer = setTimeout(checkIdle, remaining);
    };

    const markActivity = (event) => {
      const now = Date.now();
      if (event.type === "pointermove" && now - lastPointerSignal < 500) return;
      if (event.type === "pointermove") lastPointerSignal = now;
      lastActivity = now;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(checkIdle, idleTimeoutMs);
    };

    const checkVisibility = () => {
      if (document.visibilityState === "visible") checkIdle();
    };

    const events = ["keydown", "pointerdown", "pointermove", "touchstart", "wheel"];
    for (const event of events) {
      window.addEventListener(event, markActivity, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", checkVisibility);
    idleTimer = setTimeout(checkIdle, idleTimeoutMs);

    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity >= idleTimeoutMs) return;
      requestApi("/api/status")
        .then((status) => {
          if (!status.authenticated) {
            handleLocked("A sessão expirou. Informe a senha novamente.");
          }
        })
        .catch(() => {});
    }, heartbeatMs);

    return () => {
      clearTimeout(idleTimer);
      clearInterval(heartbeat);
      for (const event of events) {
        window.removeEventListener(event, markActivity, { capture: true });
      }
      document.removeEventListener("visibilitychange", checkVisibility);
    };
  }, [handleLocked, idleTimeoutMs, screen]);

  async function changePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (values.newPassword !== values.confirmation) {
      setPasswordOpen(false);
      setVaultMessage({ text: "A confirmação da nova senha não confere." });
      return;
    }
    try {
      await requestApi("/api/password", {
        method: "POST",
        csrfToken,
        body: {
          currentPassword: values.currentPassword,
          newPassword: values.newPassword
        }
      });
      form.reset();
      setPasswordOpen(false);
      setVaultMessage({ text: "Senha alterada com sucesso.", success: true });
    } catch (error) {
      setPasswordOpen(false);
      setVaultMessage({ text: error.message });
    }
  }

  if (screen === "loading") {
    return <main className="loading">Abrindo o cofre…</main>;
  }

  if (screen !== "vault") {
    return (
      <main className="shell">
        <section className="auth-card">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">◆</span>
            <div><h1>Cofre de notas</h1><p>Suas notas permanecem criptografadas no disco.</p></div>
          </div>
          <Message value={message} />
          {screen === "register" && (
            <AuthForm title="Criar cofre" submit="Criar meu cofre" confirm
              onSubmit={(event) => authenticate(event, "/api/register")}>
              <button type="button" className="secondary" onClick={() => {
                history.replaceState(null, "", "/"); setScreen("login"); setMessage(null);
              }}>Voltar ao login</button>
            </AuthForm>
          )}
          {screen === "login" && (
            <AuthForm title="Desbloquear" submit="Abrir cofre"
              onSubmit={(event) => authenticate(event, "/api/unlock")}>
              <button type="button" className="secondary" onClick={() => {
                setScreen("register"); setMessage(null);
              }}>Criar novo cofre</button>
            </AuthForm>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="vault">
        <header className="topbar">
          <div className="topbar-page">
            <span className="page-glyph" aria-hidden="true">▤</span>
            <strong>{selected?.title || "Cofre de notas"}</strong>
          </div>
          <nav>
            <button className="secondary" onClick={() => setPasswordOpen(true)}>Trocar senha</button>
            <button className="danger" onClick={() => lock()}>Bloquear</button>
          </nav>
        </header>
        <Message value={vaultMessage} />
        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar-workspace">
              <span className="workspace-avatar" aria-hidden="true">
                {(user?.username || "C").slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{user?.username}</strong>
                <small>Cofre privado</small>
              </div>
            </div>
            <div className="sidebar-section-heading">
              <span>Páginas</span>
              <button aria-label="Criar página na raiz" title="Criar página na raiz"
                onClick={() => createNote(null)}>+</button>
            </div>
            <div className="note-list">
              <NoteTree notes={notes} parentId={null} selectedId={selectedId}
                collapsedIds={collapsedIds}
                onToggle={(id) => setCollapsedIds((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                onCreateChild={createNote}
                onSelect={async (id) => { await flushSave(); setSelectedId(id); }} />
            </div>
          </aside>
          {!selected && <section className="empty-editor">Selecione uma nota ou crie uma nova.</section>}
          <section className={`editor-pane${selected ? "" : " hidden"}${dragActive ? " drag-active" : ""}`}
            ref={editorPane}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = event.dataTransfer.files.length > 0
                ? "copy"
                : "link";
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false);
            }}
            onDrop={handleEditorDrop}>
            {dragActive && (
              <div className="drop-hint">
                Solte para criptografar o arquivo ou salvar o link
              </div>
            )}
            <div className="editor-heading">
              <div className="page-heading-fields">
                <input value={selected?.title || ""} maxLength={200} aria-label="Título da nota"
                  onChange={(event) => {
                    const title = event.target.value;
                    setNotes((current) => current.map((note) =>
                      note.id === selectedId ? { ...note, title } : note
                    ));
                    queueSave();
                  }} />
                <label className="parent-picker">
                  Dentro de
                  <select value={selected?.parentId || ""}
                    onChange={(event) => moveSelected(event.target.value)}>
                    <option value="">Raiz do cofre</option>
                    {parentChoices(notes, selectedId).map(({ note, depth }) => (
                      <option key={note.id} value={note.id}>
                        {"— ".repeat(depth)}{note.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span>{saveStatus} · Markdown</span>
            </div>
            <div ref={editorElement} className="editor" />
            <div className="attachment-tools">
              <input ref={fileInput} type="file" multiple hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  event.target.value = "";
                  void uploadFiles(files);
                }} aria-label="Selecionar anexos" />
              <button className="secondary" disabled={uploading}
                onClick={() => fileInput.current?.click()}>
                {uploading ? "Criptografando e enviando…" : "Adicionar imagem ou arquivo"}
              </button>
              <small>Arraste links ou arquivos. Até 50 MiB por arquivo e 500 MiB por nota.</small>
            </div>
            {attachments.length > 0 && (
              <div className="attachment-list" aria-label="Anexos da nota">
                {attachments.map((attachment) => (
                  <div className="attachment-row" key={attachment.id}>
                    <a href={attachment.url} target="_blank" rel="noreferrer">
                      {attachment.isImage ? "Imagem" : "Arquivo"} · {attachment.name}
                    </a>
                    <small>{formatBytes(attachment.size)}</small>
                    <button className="danger" onClick={() => deleteAttachment(attachment)}>
                      Excluir
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="editor-actions">
              <button className="danger" onClick={deleteNote}>Excluir nota</button>
            </div>
          </section>
        </div>
      </section>
      {passwordOpen && (
        <Modal title="Trocar senha" onClose={() => setPasswordOpen(false)}>
          <form className="stack" onSubmit={changePassword}>
            <p>Não existe recuperação caso a nova senha seja perdida.</p>
            <label>Senha atual<input name="currentPassword" type="password" required /></label>
            <label>Nova senha<input name="newPassword" type="password" minLength={12} required /></label>
            <label>Confirmar nova senha<input name="confirmation" type="password" minLength={12} required /></label>
            <button type="submit">Alterar senha</button>
          </form>
        </Modal>
      )}
    </main>
  );
}

function AuthForm({ title, submit, children, onSubmit }) {
  return (
    <form className="stack" onSubmit={onSubmit}>
      <h2>{title}</h2>
      <label>Usuário<input name="username" autoComplete="username" required autoFocus /></label>
      <label>Senha mestra<input name="password" type="password" minLength={12} required /></label>
      {title !== "Desbloquear" &&
        <label>Confirmar senha<input name="confirmation" type="password" minLength={12} required /></label>}
      <button type="submit">{submit}</button>
      {children}
    </form>
  );
}

function NoteTree({
  notes,
  parentId,
  selectedId,
  collapsedIds,
  onToggle,
  onCreateChild,
  onSelect
}) {
  const children = notes.filter((note) => (note.parentId || null) === parentId);
  return children.map((note) => {
    const hasChildren = notes.some((item) => item.parentId === note.id);
    const collapsed = collapsedIds.has(note.id);
    return (
      <div className="note-tree-node" key={note.id}>
        <div className="note-tree-row">
          <button className="tree-toggle" disabled={!hasChildren}
            aria-label={`${collapsed ? "Expandir" : "Recolher"} ${note.title}`}
            onClick={() => hasChildren && onToggle(note.id)}>
            {hasChildren ? (collapsed ? "▸" : "▾") : "·"}
          </button>
          <span className="page-glyph" aria-hidden="true">▤</span>
          <button className={`note-item${note.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(note.id)}>
            <strong>{note.title}</strong>
          </button>
          <button className="add-child" aria-label={`Criar subpágina em ${note.title}`}
            onClick={() => onCreateChild(note.id)}>+</button>
        </div>
        {hasChildren && !collapsed && (
          <div className="note-children">
            <NoteTree notes={notes} parentId={note.id} selectedId={selectedId}
              collapsedIds={collapsedIds} onToggle={onToggle}
              onCreateChild={onCreateChild} onSelect={onSelect} />
          </div>
        )}
      </div>
    );
  });
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Fechar">×</button></header>
        {children}
      </section>
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatIdleDuration(milliseconds) {
  const minutes = milliseconds / (60 * 1000);
  if (minutes < 1) return `${Math.round(milliseconds / 1000)} segundos`;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutos`;
}

function collectDescendantIds(notes, parentId) {
  const descendants = new Set();
  const pending = [parentId];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const note of notes) {
      if (note.parentId === current && !descendants.has(note.id)) {
        descendants.add(note.id);
        pending.push(note.id);
      }
    }
  }
  return descendants;
}

function parentChoices(notes, selectedId) {
  const unavailable = collectDescendantIds(notes, selectedId);
  unavailable.add(selectedId);
  const choices = [];

  function visit(parentId, depth) {
    for (const note of notes) {
      if ((note.parentId || null) !== parentId) continue;
      if (!unavailable.has(note.id)) choices.push({ note, depth });
      visit(note.id, depth + 1);
    }
  }

  visit(null, 0);
  return choices;
}
