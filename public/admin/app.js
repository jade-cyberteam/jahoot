/**
 * The quiz builder. Talks to /admin/api/quizzes, which is the same CRUD surface
 * the token API exposes — so a quiz written here and one written by Claude Code
 * are the same record.
 */

import { $, GLYPHS, api, show, text } from "/app/common.js";
import { qrSvg } from "/app/qr.js";

const DEFAULT_TIME = 20;
const DEFAULT_POINTS = 1000;

/** Working copy of the quiz being edited. */
let draft = null;
let editingId = null;

const listView = $("#listView");
const editView = $("#editView");

function flash(el, message, ms = 4000) {
  el.textContent = message;
  show(el, true);
  setTimeout(() => show(el, false), ms);
}

const fail = (message) => flash($("#error"), message, 7000);
const okay = (message) => flash($("#ok"), message);

// ---- list ----

async function loadList() {
  show(editView, false);
  show(listView, true);
  try {
    const { quizzes } = await api("/admin/api/quizzes");
    const body = $("#listBody");
    body.innerHTML = "";
    show($("#empty"), quizzes.length === 0);
    show($("#listTable"), quizzes.length > 0);

    for (const quiz of quizzes) {
      const tr = document.createElement("tr");

      const title = document.createElement("td");
      title.textContent = quiz.title;

      const count = document.createElement("td");
      count.className = "score mono";
      count.textContent = quiz.questionCount;

      const updated = document.createElement("td");
      updated.className = "note";
      updated.textContent = new Date(quiz.updatedAt).toLocaleDateString();

      const by = document.createElement("td");
      by.className = "note";
      by.textContent = quiz.createdBy;

      const actions = document.createElement("td");
      actions.append(
        link("Host", `/host/${quiz.id}`),
        button("Share", "quiet", () => share(quiz)),
        button("Edit", "quiet", () => edit(quiz.id)),
        button("Delete", "danger", () => remove(quiz)),
      );
      actions.className = "row";

      tr.append(title, count, updated, by, actions);
      body.append(tr);
    }
  } catch (e) {
    fail(e.message);
  }
}

function link(label, href) {
  const a = document.createElement("a");
  a.className = "btn";
  a.dataset.variant = "quiet";
  a.style.fontSize = "0.8rem";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = label;
  return a;
}

function button(label, variant, onClick) {
  const b = document.createElement("button");
  b.className = "btn";
  if (variant) b.dataset.variant = variant;
  b.style.fontSize = "0.8rem";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The share link for a quiz is its *host* link — a game, and therefore a join
 * passcode, doesn't exist until someone opens it. So this is the link you send
 * to whoever is running the quiz, not to players; the dialog says so, because a
 * host link scanned on a phone would quietly start a game on that phone.
 */
function share(quiz) {
  const url = quiz.hostUrl || `${location.origin}/host/${quiz.id}`;
  const dialog = $("#shareDialog");

  text($("#shareTitle"), quiz.title);
  $("#shareUrl").value = url;
  const svg = qrSvg(url);
  $("#shareQr").innerHTML = svg || "";
  show($("#shareQr"), Boolean(svg));

  const copy = $("#shareCopy");
  text(copy, "Copy link");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      text(copy, "Copied");
    } catch {
      // Clipboard access can be refused; the field is selectable either way.
      $("#shareUrl").select();
      text(copy, "Press Cmd+C");
    }
  };

  dialog.showModal();
}

async function remove(quiz) {
  if (!confirm(`Delete "${quiz.title}"? This can't be undone.`)) return;
  try {
    await api(`/admin/api/quizzes/${quiz.id}`, { method: "DELETE" });
    okay(`Deleted "${quiz.title}".`);
    await loadList();
  } catch (e) {
    fail(e.message);
  }
}

// ---- editor ----

function blankQuestion(type) {
  return {
    type,
    text: "",
    timeLimit: DEFAULT_TIME,
    points: DEFAULT_POINTS,
    answers:
      type === "boolean"
        ? [{ text: "True", correct: true }, { text: "False", correct: false }]
        : [
            { text: "", correct: true },
            { text: "", correct: false },
            { text: "", correct: false },
            { text: "", correct: false },
          ],
  };
}

function startNew() {
  editingId = null;
  draft = { title: "", description: "", questions: [blankQuestion("multiple")] };
  text($("#editHeading"), "New quiz");
  paintEditor();
}

async function edit(id) {
  try {
    const quiz = await api(`/admin/api/quizzes/${id}`);
    editingId = id;
    draft = {
      title: quiz.title,
      description: quiz.description,
      questions: quiz.questions.map((q) => ({
        type: q.type,
        text: q.text,
        timeLimit: q.timeLimit,
        points: q.points,
        answers: q.answers.map((a) => ({ text: a.text, correct: a.correct })),
      })),
    };
    text($("#editHeading"), `Editing "${quiz.title}"`);
    paintEditor();
  } catch (e) {
    fail(e.message);
  }
}

function paintEditor() {
  show(listView, false);
  show(editView, true);
  $("#qTitle").value = draft.title;
  $("#qDesc").value = draft.description;
  paintQuestions();
}

function paintQuestions() {
  const host = $("#questions");
  host.innerHTML = "";
  draft.questions.forEach((question, qi) => host.append(questionCard(question, qi)));
}

function questionCard(question, qi) {
  const card = document.createElement("div");
  card.className = "panel stack";

  const head = document.createElement("div");
  head.className = "spread";
  const label = document.createElement("p");
  label.className = "eyebrow";
  label.style.margin = "0";
  label.textContent = `${qi + 1} · ${question.type === "boolean" ? "True / false" : "Multiple choice"}`;
  const tools = document.createElement("div");
  tools.className = "row";
  if (qi > 0) tools.append(button("Up", "quiet", () => move(qi, -1)));
  if (qi < draft.questions.length - 1) tools.append(button("Down", "quiet", () => move(qi, 1)));
  if (draft.questions.length > 1) {
    tools.append(button("Remove", "danger", () => {
      draft.questions.splice(qi, 1);
      paintQuestions();
    }));
  }
  head.append(label, tools);
  card.append(head);

  card.append(
    field("Question", (input) => {
      input.value = question.text;
      input.maxLength = 300;
      input.placeholder = "Which river is New Zealand's longest?";
      input.addEventListener("input", () => { question.text = input.value; });
    }),
  );

  const settings = document.createElement("div");
  settings.className = "row";
  settings.append(
    field("Seconds", (input) => {
      input.type = "number";
      input.min = 5;
      input.max = 120;
      input.value = question.timeLimit;
      input.style.width = "7rem";
      input.addEventListener("input", () => {
        question.timeLimit = Number(input.value) || DEFAULT_TIME;
      });
    }, "7rem"),
    field("Points", (input) => {
      input.type = "number";
      input.min = 0;
      input.max = 2000;
      input.step = 100;
      input.value = question.points;
      input.style.width = "7rem";
      input.addEventListener("input", () => {
        question.points = Number(input.value) || 0;
      });
    }, "7rem"),
  );
  card.append(settings);

  const answers = document.createElement("div");
  answers.className = "stack";
  question.answers.forEach((answer, ai) => {
    const row = document.createElement("div");
    row.className = "row";

    const glyph = document.createElement("span");
    glyph.className = "tile-glyph";
    glyph.style.background = `var(--tile-${"abcdef"[ai]})`;
    glyph.style.color = "#10121f";
    glyph.textContent = GLYPHS[ai] ?? "●";
    row.append(glyph);

    const input = document.createElement("input");
    input.value = answer.text;
    input.maxLength = 120;
    input.placeholder = `Answer ${ai + 1}`;
    input.style.flex = "1";
    input.disabled = question.type === "boolean";
    input.addEventListener("input", () => { answer.text = input.value; });
    row.append(input);

    const correct = document.createElement("label");
    correct.style.display = "flex";
    correct.style.alignItems = "center";
    correct.style.gap = "0.4rem";
    correct.style.margin = "0";
    correct.style.whiteSpace = "nowrap";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `correct-${qi}`;
    radio.checked = answer.correct;
    radio.style.width = "auto";
    radio.addEventListener("change", () => {
      question.answers.forEach((a, i) => { a.correct = i === ai; });
    });
    correct.append(radio, document.createTextNode("Correct"));
    row.append(correct);

    if (question.type === "multiple" && question.answers.length > 2) {
      row.append(button("×", "quiet", () => {
        question.answers.splice(ai, 1);
        if (!question.answers.some((a) => a.correct)) question.answers[0].correct = true;
        paintQuestions();
      }));
    }

    answers.append(row);
  });
  card.append(answers);

  if (question.type === "multiple" && question.answers.length < 6) {
    card.append(
      button("Add answer", "quiet", () => {
        question.answers.push({ text: "", correct: false });
        paintQuestions();
      }),
    );
  }

  return card;
}

function field(labelText, configure, width) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.style.margin = "0";
  if (width) wrap.style.width = width;
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  label.htmlFor = input.id = `f${Math.random().toString(36).slice(2, 9)}`;
  configure(input);
  wrap.append(label, input);
  return wrap;
}

function move(index, delta) {
  const [item] = draft.questions.splice(index, 1);
  draft.questions.splice(index + delta, 0, item);
  paintQuestions();
}

async function save() {
  draft.title = $("#qTitle").value.trim();
  draft.description = $("#qDesc").value.trim();

  // Catch the obvious mistakes here so the server's 400 is a backstop, not the
  // first thing you see.
  if (!draft.title) return flash($("#editError"), "Give the quiz a title.");
  for (const [i, q] of draft.questions.entries()) {
    if (!q.text.trim()) return flash($("#editError"), `Question ${i + 1} has no text.`);
    if (q.answers.some((a) => !a.text.trim())) {
      return flash($("#editError"), `Question ${i + 1} has an empty answer.`);
    }
    if (!q.answers.some((a) => a.correct)) {
      return flash($("#editError"), `Question ${i + 1} has no correct answer marked.`);
    }
  }

  const button = $("#save");
  button.disabled = true;
  try {
    const path = editingId ? `/admin/api/quizzes/${editingId}` : "/admin/api/quizzes";
    const saved = await api(path, {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(draft),
    });
    okay(`Saved "${saved.title}". Host it at ${saved.hostUrl}`);
    await loadList();
  } catch (e) {
    flash($("#editError"), e.message, 7000);
  } finally {
    button.disabled = false;
  }
}

// ---- wire up ----

$("#new").addEventListener("click", startNew);
$("#shareClose").addEventListener("click", () => $("#shareDialog").close());
$("#cancel").addEventListener("click", loadList);
$("#save").addEventListener("click", save);
$("#addMultiple").addEventListener("click", () => {
  draft.questions.push(blankQuestion("multiple"));
  paintQuestions();
});
$("#addBoolean").addEventListener("click", () => {
  draft.questions.push(blankQuestion("boolean"));
  paintQuestions();
});

api("/admin/api/whoami")
  .then(({ email }) => text($("#whoami"), email))
  .catch(() => {});

loadList();
