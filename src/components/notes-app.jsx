"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const [saveStatus, setSaveStatus] = useState("Salvo");
  const [adminOpen, setAdminOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [invites, setInvites] = useState([]);
  const [inviteLink, setInviteLink] = useState("");
  const editorElement = useRef(null);
  const quill = useRef(null);
  const loadingEditor = useRef(false);
  const saveTimer = useRef(null);
  const saving = useRef(false);
  const pendingSave = useRef(false);
  const notesRef = useRef(notes);
  const selectedIdRef = useRef(selectedId);
  const csrfRef = useRef(csrfToken);
  const saveCurrentRef = useRef(null);
  const selected = notes.find((note) => note.id === selectedId) || null;

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { csrfRef.current = csrfToken; }, [csrfToken]);

  const handleLocked = useCallback(() => {
    setCsrfToken("");
    setUser(null);
    setNotes([]);
    setSelectedId(null);
    setScreen("login");
    setMessage({ text: "A sessão foi bloqueada. Informe a senha novamente." });
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
        if (status.authenticated) {
          setCsrfToken(status.csrfToken);
          setUser(status.user);
          setScreen("vault");
          await loadNotes();
        } else if (status.bootstrapRequired) {
          setScreen("bootstrap");
        } else if (new URLSearchParams(location.search).has("invite")) {
          setScreen("register");
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
    loadingEditor.current = true;
    quill.current.setContents(noteToDelta(quill.current, note), "silent");
    loadingEditor.current = false;
    setSaveStatus("Salvo");
  }, [selectedId]);

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
    if (endpoint === "/api/bootstrap") body.setupToken = values.setupToken;
    if (endpoint === "/api/register") {
      body.inviteToken = new URLSearchParams(location.search).get("invite") || "";
    }
    try {
      const result = await requestApi(endpoint, { method: "POST", body });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      setScreen("vault");
      form.reset();
      if (endpoint === "/api/register") history.replaceState(null, "", "/");
      await loadNotes();
    } catch (error) {
      setMessage({ text: error.message });
    }
  }

  async function createNote() {
    setVaultMessage(null);
    await flushSave();
    try {
      const result = await requestApi("/api/notes", {
        method: "POST",
        csrfToken,
        body: { title: "Nova nota", markdown: "" }
      });
      setNotes((current) => [result.note, ...current]);
      setSelectedId(result.note.id);
    } catch (error) {
      if (error.status === 401) handleLocked();
      else setVaultMessage({ text: error.message });
    }
  }

  async function deleteNote() {
    if (!selected || !confirm(`Excluir definitivamente “${selected.title}”?`)) return;
    try {
      await requestApi(`/api/notes/${selected.id}`, {
        method: "DELETE",
        csrfToken
      });
      const remaining = notes.filter((note) => note.id !== selected.id);
      setNotes(remaining);
      setSelectedId(remaining[0]?.id || null);
    } catch (error) {
      if (error.status === 401) handleLocked();
      else setVaultMessage({ text: error.message });
    }
  }

  async function lock() {
    await flushSave();
    try {
      await requestApi("/api/lock", { method: "POST", csrfToken, body: {} });
    } finally {
      handleLocked();
    }
  }

  async function openInvites() {
    setAdminOpen(true);
    setInviteLink("");
    try {
      const result = await requestApi("/api/invites");
      setInvites(result.invites);
    } catch (error) {
      setVaultMessage({ text: error.message });
    }
  }

  async function createInvite() {
    try {
      const result = await requestApi("/api/invites", {
        method: "POST",
        csrfToken,
        body: {}
      });
      const url = new URL(location.origin);
      url.searchParams.set("invite", result.token);
      setInviteLink(url.toString());
      const refreshed = await requestApi("/api/invites");
      setInvites(refreshed.invites);
    } catch (error) {
      setVaultMessage({ text: error.message });
    }
  }

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
          {screen === "bootstrap" && (
            <AuthForm title="Configuração inicial" submit="Criar cofre administrativo"
              setup onSubmit={(event) => authenticate(event, "/api/bootstrap")} />
          )}
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
              onSubmit={(event) => authenticate(event, "/api/unlock")} />
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="vault">
        <header className="topbar">
          <div><strong>Cofre de notas</strong><span className="current-user">{user?.username}</span></div>
          <nav>
            {user?.role === "admin" && <button className="secondary" onClick={openInvites}>Convites</button>}
            <button className="secondary" onClick={() => setPasswordOpen(true)}>Trocar senha</button>
            <button className="danger" onClick={lock}>Bloquear</button>
          </nav>
        </header>
        <Message value={vaultMessage} />
        <div className="workspace">
          <aside className="sidebar">
            <button onClick={createNote}>+ Nova nota</button>
            <div className="note-list">
              {notes.map((note) => (
                <button key={note.id} className={`note-item${note.id === selectedId ? " active" : ""}`}
                  onClick={async () => { await flushSave(); setSelectedId(note.id); }}>
                  <strong>{note.title}</strong>
                  <small>{new Date(note.updatedAt).toLocaleString()}</small>
                </button>
              ))}
            </div>
          </aside>
          {!selected && <section className="empty-editor">Selecione uma nota ou crie uma nova.</section>}
          <section className={`editor-pane${selected ? "" : " hidden"}`}>
            <div className="editor-heading">
              <input value={selected?.title || ""} maxLength={200} aria-label="Título da nota"
                onChange={(event) => {
                  const title = event.target.value;
                  setNotes((current) => current.map((note) =>
                    note.id === selectedId ? { ...note, title } : note
                  ));
                  queueSave();
                }} />
              <span>{saveStatus} · Markdown</span>
            </div>
            <div ref={editorElement} className="editor" />
            <div className="editor-actions">
              <button className="danger" onClick={deleteNote}>Excluir nota</button>
            </div>
          </section>
        </div>
      </section>
      {adminOpen && (
        <Modal title="Convites" onClose={() => setAdminOpen(false)}>
          <p>O convite vale por 24 horas e só pode ser usado uma vez.</p>
          <button onClick={createInvite}>Gerar convite</button>
          {inviteLink && <div className="invite-result"><input value={inviteLink} readOnly />
            <button className="secondary" onClick={() => navigator.clipboard.writeText(inviteLink)}>Copiar link</button>
          </div>}
          <div className="invite-list">{invites.map((invite) => {
            const status = invite.consumedAt ? "Utilizado" :
              new Date(invite.expiresAt) <= new Date() ? "Expirado" : "Pendente";
            return <div className="invite-row" key={invite.id}>{status} · criado em {new Date(invite.createdAt).toLocaleString()}</div>;
          })}</div>
        </Modal>
      )}
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

function AuthForm({ title, submit, setup = false, children, onSubmit }) {
  return (
    <form className="stack" onSubmit={onSubmit}>
      <h2>{title}</h2>
      {setup && <><p>Crie o primeiro administrador. Não existe recuperação de senha.</p>
        <label>Token de configuração<input name="setupToken" type="password" required /></label></>}
      <label>Usuário<input name="username" autoComplete="username" required autoFocus /></label>
      <label>Senha mestra<input name="password" type="password" minLength={12} required /></label>
      {title !== "Desbloquear" &&
        <label>Confirmar senha<input name="confirmation" type="password" minLength={12} required /></label>}
      <button type="submit">{submit}</button>
      {children}
    </form>
  );
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
