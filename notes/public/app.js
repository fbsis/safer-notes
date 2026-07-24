"use strict";

const $ = (selector) => document.querySelector(selector);

const ui = {
  authView: $("#authView"),
  vaultView: $("#vaultView"),
  message: $("#message"),
  vaultMessage: $("#vaultMessage"),
  bootstrapForm: $("#bootstrapForm"),
  registerForm: $("#registerForm"),
  loginForm: $("#loginForm"),
  showLogin: $("#showLogin"),
  currentUser: $("#currentUser"),
  adminButton: $("#adminButton"),
  passwordButton: $("#passwordButton"),
  lockButton: $("#lockButton"),
  newNoteButton: $("#newNoteButton"),
  noteList: $("#noteList"),
  emptyEditor: $("#emptyEditor"),
  editorPane: $("#editorPane"),
  noteTitle: $("#noteTitle"),
  saveStatus: $("#saveStatus"),
  deleteNoteButton: $("#deleteNoteButton"),
  adminDialog: $("#adminDialog"),
  createInviteButton: $("#createInviteButton"),
  inviteResult: $("#inviteResult"),
  inviteLink: $("#inviteLink"),
  copyInviteButton: $("#copyInviteButton"),
  inviteList: $("#inviteList"),
  passwordDialog: $("#passwordDialog"),
  passwordForm: $("#passwordForm"),
  closePasswordButton: $("#closePasswordButton")
};

const state = {
  csrfToken: "",
  user: null,
  notes: [],
  selectedId: null,
  saveTimer: null,
  loadingEditor: false,
  saving: false,
  pendingSave: false
};

const quill = new Quill("#editor", {
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

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (state.csrfToken && options.method && options.method !== "GET") {
    headers.set("X-CSRF-Token", state.csrfToken);
  }
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "Não foi possível concluir a operação.");
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

function showMessage(target, text, success = false) {
  target.textContent = text;
  target.classList.toggle("success", success);
  target.classList.remove("hidden");
}

function hideMessage(target) {
  target.textContent = "";
  target.classList.add("hidden");
}

function showOnly(form) {
  [ui.bootstrapForm, ui.registerForm, ui.loginForm].forEach((item) => {
    item.classList.toggle("hidden", item !== form);
  });
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function assertConfirmation(values, passwordField = "password") {
  if (values[passwordField] !== values.confirmation) {
    throw new Error("A confirmação da senha não confere.");
  }
}

function setBusy(form, busy) {
  for (const element of form.elements) element.disabled = busy;
}

async function submitAuth(form, url, transform = (value) => value) {
  hideMessage(ui.message);
  setBusy(form, true);
  try {
    const values = formValues(form);
    const result = await api(url, { method: "POST", body: transform(values) });
    state.csrfToken = result.csrfToken;
    state.user = result.user;
    if (url === "/api/register") {
      history.replaceState(null, "", location.pathname);
    }
    form.reset();
    await enterVault();
  } catch (error) {
    showMessage(ui.message, error.message);
  } finally {
    setBusy(form, false);
  }
}

ui.bootstrapForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(ui.bootstrapForm, "/api/bootstrap", (values) => {
    assertConfirmation(values);
    return {
      setupToken: values.setupToken,
      username: values.username,
      password: values.password
    };
  });
});

ui.registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(ui.registerForm, "/api/register", (values) => {
    assertConfirmation(values);
    return {
      inviteToken: new URLSearchParams(location.search).get("invite") || "",
      username: values.username,
      password: values.password
    };
  });
});

ui.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(ui.loginForm, "/api/unlock");
});

ui.showLogin.addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  showOnly(ui.loginForm);
  hideMessage(ui.message);
});

function selectedNote() {
  return state.notes.find((note) => note.id === state.selectedId);
}

function renderNoteList() {
  ui.noteList.replaceChildren();
  for (const note of state.notes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `note-item${note.id === state.selectedId ? " active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = note.title;
    const date = document.createElement("small");
    date.textContent = new Date(note.updatedAt).toLocaleString();
    button.append(title, date);
    button.addEventListener("click", async () => {
      await flushSave();
      selectNote(note.id);
    });
    ui.noteList.append(button);
  }
}

function selectNote(id) {
  state.selectedId = id;
  const note = selectedNote();
  renderNoteList();
  ui.emptyEditor.classList.toggle("hidden", Boolean(note));
  ui.editorPane.classList.toggle("hidden", !note);
  if (!note) return;
  state.loadingEditor = true;
  ui.noteTitle.value = note.title;
  quill.setContents(note.delta, "silent");
  state.loadingEditor = false;
  ui.saveStatus.textContent = "Salvo";
}

async function loadNotes(preferredId) {
  const result = await api("/api/notes");
  state.notes = result.notes;
  const target =
    preferredId && state.notes.some((note) => note.id === preferredId)
      ? preferredId
      : state.notes[0]?.id || null;
  selectNote(target);
}

function queueSave() {
  if (state.loadingEditor || !state.selectedId) return;
  ui.saveStatus.textContent = "Alterações pendentes";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrent, 800);
}

async function saveCurrent() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  const note = selectedNote();
  if (!note) return;
  if (state.saving) {
    state.pendingSave = true;
    return;
  }
  state.saving = true;
  ui.saveStatus.textContent = "Salvando…";
  const snapshot = {
    id: note.id,
    title: ui.noteTitle.value.trim() || "Sem título",
    delta: quill.getContents(),
    revision: note.revision
  };
  try {
    const result = await api(`/api/notes/${snapshot.id}`, {
      method: "PATCH",
      body: snapshot
    });
    const index = state.notes.findIndex((item) => item.id === snapshot.id);
    if (index !== -1) {
      state.notes[index] = {
        ...state.notes[index],
        ...result.note
      };
    }
    ui.saveStatus.textContent = "Salvo";
    renderNoteList();
  } catch (error) {
    ui.saveStatus.textContent = "Erro ao salvar";
    if (error.status === 401) return handleLocked();
    if (error.status === 409) {
      showMessage(ui.vaultMessage, "A nota mudou em outra sessão. A lista foi recarregada.");
      await loadNotes(snapshot.id);
    } else {
      showMessage(ui.vaultMessage, error.message);
    }
  } finally {
    state.saving = false;
    if (state.pendingSave) {
      state.pendingSave = false;
      await saveCurrent();
    }
  }
}

async function flushSave() {
  if (state.saveTimer) await saveCurrent();
  while (state.saving) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

ui.noteTitle.addEventListener("input", queueSave);
quill.on("text-change", queueSave);

ui.newNoteButton.addEventListener("click", async () => {
  hideMessage(ui.vaultMessage);
  await flushSave();
  try {
    const result = await api("/api/notes", {
      method: "POST",
      body: { title: "Nova nota", delta: { ops: [{ insert: "\n" }] } }
    });
    state.notes.unshift(result.note);
    selectNote(result.note.id);
    ui.noteTitle.select();
  } catch (error) {
    if (error.status === 401) return handleLocked();
    showMessage(ui.vaultMessage, error.message);
  }
});

ui.deleteNoteButton.addEventListener("click", async () => {
  const note = selectedNote();
  if (!note || !confirm(`Excluir definitivamente “${note.title}”?`)) return;
  try {
    await api(`/api/notes/${note.id}`, { method: "DELETE" });
    state.notes = state.notes.filter((item) => item.id !== note.id);
    selectNote(state.notes[0]?.id || null);
  } catch (error) {
    if (error.status === 401) return handleLocked();
    showMessage(ui.vaultMessage, error.message);
  }
});

async function handleLocked() {
  state.csrfToken = "";
  state.user = null;
  state.notes = [];
  state.selectedId = null;
  ui.vaultView.classList.add("hidden");
  ui.authView.classList.remove("hidden");
  showOnly(ui.loginForm);
  showMessage(ui.message, "A sessão foi bloqueada. Informe a senha novamente.");
}

ui.lockButton.addEventListener("click", async () => {
  await flushSave();
  try {
    await api("/api/lock", { method: "POST", body: {} });
  } finally {
    handleLocked();
  }
});

async function loadInvites() {
  const result = await api("/api/invites");
  ui.inviteList.replaceChildren();
  for (const invite of result.invites) {
    const row = document.createElement("div");
    row.className = "invite-row";
    const status = invite.consumedAt
      ? "Utilizado"
      : new Date(invite.expiresAt) <= new Date()
        ? "Expirado"
        : "Pendente";
    row.textContent = `${status} · criado em ${new Date(invite.createdAt).toLocaleString()}`;
    ui.inviteList.append(row);
  }
}

ui.adminButton.addEventListener("click", async () => {
  ui.inviteResult.classList.add("hidden");
  ui.adminDialog.showModal();
  try {
    await loadInvites();
  } catch (error) {
    showMessage(ui.vaultMessage, error.message);
  }
});

ui.createInviteButton.addEventListener("click", async () => {
  try {
    const result = await api("/api/invites", { method: "POST", body: {} });
    const url = new URL(location.origin);
    url.searchParams.set("invite", result.token);
    ui.inviteLink.value = url.toString();
    ui.inviteResult.classList.remove("hidden");
    await loadInvites();
  } catch (error) {
    showMessage(ui.vaultMessage, error.message);
  }
});

ui.copyInviteButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(ui.inviteLink.value);
  ui.copyInviteButton.textContent = "Copiado";
  setTimeout(() => { ui.copyInviteButton.textContent = "Copiar link"; }, 1500);
});

ui.passwordButton.addEventListener("click", () => {
  ui.passwordForm.reset();
  ui.passwordDialog.showModal();
});

ui.closePasswordButton.addEventListener("click", () => ui.passwordDialog.close());

ui.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(ui.passwordForm, true);
  try {
    const values = formValues(ui.passwordForm);
    assertConfirmation(values, "newPassword");
    await api("/api/password", {
      method: "POST",
      body: {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword
      }
    });
    ui.passwordDialog.close();
    showMessage(ui.vaultMessage, "Senha alterada com sucesso.", true);
  } catch (error) {
    showMessage(ui.vaultMessage, error.message);
    ui.passwordDialog.close();
  } finally {
    setBusy(ui.passwordForm, false);
  }
});

async function enterVault() {
  ui.authView.classList.add("hidden");
  ui.vaultView.classList.remove("hidden");
  hideMessage(ui.vaultMessage);
  ui.currentUser.textContent = state.user.username;
  ui.adminButton.classList.toggle("hidden", state.user.role !== "admin");
  await loadNotes();
}

async function initialize() {
  try {
    const status = await api("/api/status");
    if (status.authenticated) {
      state.csrfToken = status.csrfToken;
      state.user = status.user;
      await enterVault();
      return;
    }
    ui.authView.classList.remove("hidden");
    if (status.bootstrapRequired) {
      showOnly(ui.bootstrapForm);
    } else if (new URLSearchParams(location.search).has("invite")) {
      showOnly(ui.registerForm);
    } else {
      showOnly(ui.loginForm);
    }
  } catch (error) {
    showMessage(ui.message, error.message);
  }
}

initialize();
