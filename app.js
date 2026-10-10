
"use strict";

/* =====================================================
   BuCor Exam Review — app.js
   Compatible with index.html and style.css
   Backend: Google Apps Script JSONP
   ===================================================== */

// 1. CONFIGURATION
const API_URL = "https://script.google.com/macros/s/AKfycbyewnNfvmVW76tos2yOO5bThGKvvuZdBPDFKYSwQhoiqhy6KAe-EQkGAy7WqAdb5PcZ4g/exec";
const SPEED_DURATION = 60;
const STORAGE_KEY = "bucorExamReview_v1";

// 2. APPLICATION STATE
let flashcards = [];
let questions = [];
let topics = [];

let filteredCards = [];
let flashIndex = 0;
let flashFlipped = false;
let knownCards = new Set();

let quizQuestions = [];
let quizIndex = 0;
let quizScore = 0;
let quizAnswered = false;
let quizResults = [];

let speedQuestions = [];
let speedIndex = 0;
let speedScore = 0;
let speedAttempted = 0;
let speedAnswered = false;
let speedFinished = false;
let speedDeadline = 0;
let speedTimer = null;

let quizHistory = [];
let missedQuestions = new Map();
let toastTimeout = null;

const $ = (id) => document.getElementById(id);

// 3. GENERAL HELPERS
function shuffleArray(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = $("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimeout);

  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 2800);
}

function setConnection(message, status = "") {
  const element = $("connectionStatus");
  if (!element) return;

  element.textContent = message;
  element.classList.remove("online", "offline");

  if (status) element.classList.add(status);
}

function getCardId(card) {
  return `${card.topic}::${card.question}::${card.answer}`;
}

function getQuestionId(question) {
  return `${question.topic}::${question.question}::${JSON.stringify(question.options)}`;
}

// 4. LOCAL PROGRESS
function loadSavedProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");

    knownCards = new Set(
      Array.isArray(saved.knownCards) ? saved.knownCards : []
    );

    quizHistory = Array.isArray(saved.quizHistory)
      ? saved.quizHistory
      : [];

    missedQuestions = new Map(
      Array.isArray(saved.missedQuestions)
        ? saved.missedQuestions
        : []
    );
  } catch (error) {
    console.warn("Could not load saved progress:", error);
  }
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      knownCards: [...knownCards],
      quizHistory,
      missedQuestions: [...missedQuestions.entries()]
    }));
  } catch (error) {
    console.warn("Could not save progress:", error);
  }
}

// 5. NORMALIZE BACKEND DATA
function normalizeCard(card) {
  return {
    ...card,
    topic: String(card.topic || card.subject || "General"),
    question: String(
      card.question || card.front || card.term || card.prompt || ""
    ),
    answer: String(
      card.answer || card.back || card.definition || card.explanation || ""
    )
  };
}

function normalizeQuestion(question) {
  let options = question.options || question.choices || question.answers;

  if (!Array.isArray(options) && options && typeof options === "object") {
    options = Object.values(options);
  }

  if (!Array.isArray(options)) {
    options = [
      question.optionA ?? question.A,
      question.optionB ?? question.B,
      question.optionC ?? question.C,
      question.optionD ?? question.D
    ].filter((value) => value !== undefined && value !== null && value !== "");
  }

  options = options.map((option) => {
    if (option && typeof option === "object") {
      return String(option.text ?? option.label ?? option.value ?? "");
    }
    return String(option);
  });

  const normalized = {
    ...question,
    topic: String(question.topic || question.subject || "General"),
    question: String(
      question.question || question.text || question.front || question.prompt || ""
    ),
    options,
    explanation: String(question.explanation || question.rationale || "")
  };

  normalized.correctIndex = findCorrectAnswer(normalized);

  return normalized;
}

function findCorrectAnswer(question) {
  let answer =
    question.answer ??
    question.correctAnswer ??
    question.correct_answer ??
    question.correct ??
    question.answerIndex ??
    question.correctIndex ??
    question.key;

  if (answer === undefined || answer === null || answer === "") {
    return -1;
  }

  if (typeof answer === "number" && Number.isInteger(answer)) {
    // Supports zero-based indexes and common one-based answer numbers.
    if (answer >= 0 && answer < question.options.length) return answer;
    if (answer >= 1 && answer <= question.options.length) return answer - 1;
    return -1;
  }

  if (typeof answer === "string") {
    const value = answer.trim();

    // Answer keys A, B, C, D.
    if (/^[A-Z]$/i.test(value)) {
      const index = value.toUpperCase().charCodeAt(0) - 65;
      return index < question.options.length ? index : -1;
    }

    // A full answer matching an option.
    const match = question.options.findIndex(
      (option) => option.trim().toLowerCase() === value.toLowerCase()
    );

    if (match >= 0) return match;

    // Numeric strings: "0", "1", "2", etc.
    if (/^\d+$/.test(value)) {
      const number = Number(value);
      if (number >= 0 && number < question.options.length) return number;
      if (number >= 1 && number <= question.options.length) return number - 1;
    }
  }

  return -1;
}

// 6. LOAD STUDY MATERIALS THROUGH JSONP
function loadStudyMaterials() {
  setConnection("Connecting...");

  const callbackName =
    "bucorCallback_" + Date.now() + "_" +
    Math.random().toString(36).slice(2);

  let script = null;
  let timeout = null;
  let finished = false;

  function cleanup() {
    if (finished) return;
    finished = true;

    clearTimeout(timeout);

    if (script) script.remove();

    try {
      delete window[callbackName];
    } catch (_) {
      window[callbackName] = undefined;
    }
  }

  window[callbackName] = function (data) {
    cleanup();

    try {
      if (!data || data.ok === false) {
        throw new Error(data?.error || "Invalid backend response.");
      }

      // Flashcards confirmed in your backend response.
      const rawCards = Array.isArray(data.flashcards)
        ? data.flashcards
        : Array.isArray(data.cards)
          ? data.cards
          : [];

      // Support common names for quiz collections.
      const rawQuestions = Array.isArray(data.questions)
        ? data.questions
        : Array.isArray(data.quizQuestions)
          ? data.quizQuestions
          : Array.isArray(data.quiz)
            ? data.quiz
            : Array.isArray(data.mcqs)
              ? data.mcqs
              : [];

      flashcards = rawCards
        .map(normalizeCard)
        .filter((card) => card.question && card.answer);

      questions = rawQuestions
        .map(normalizeQuestion)
        .filter((question) =>
          question.question &&
          question.options.length >= 2 &&
          question.correctIndex >= 0 &&
          question.correctIndex < question.options.length
        );

      const backendTopics = Array.isArray(data.topics)
        ? data.topics.map((topic) => {
            if (typeof topic === "string") return topic;
            return String(topic.name || topic.topic || "");
          })
        : [];

      topics = [...new Set([
        ...backendTopics,
        ...flashcards.map((card) => card.topic),
        ...questions.map((question) => question.topic)
      ])].filter(Boolean).sort((a, b) => a.localeCompare(b));

      renderTopicOptions();
      renderTopicGrid();
      updateStatistics();
      renderFlashcard();

      if ($("contentSummary")) {
        $("contentSummary").textContent =
          `${flashcards.length} flashcards · ${questions.length} practice questions`;
      }

      setConnection("Connected", "online");

      if (flashcards.length === 0 && questions.length === 0) {
        showToast("Connected, but no usable study materials were found.");
      } else if (questions.length === 0) {
        showToast("Flashcards loaded. Quiz questions need verification.");
      } else {
        showToast("Study materials loaded successfully.");
      }

      console.info("BuCor study data loaded:", {
        topics: topics.length,
        flashcards: flashcards.length,
        validQuizQuestions: questions.length,
        backendVersion: data.version
      });
    } catch (error) {
      console.error("Could not process study materials:", error);
      setConnection("Data error", "offline");
      showToast("The data format needs checking. See the Console.");
    }
  };

  const separator = API_URL.includes("?") ? "&" : "?";

  script = document.createElement("script");
  script.src =
    API_URL + separator + "callback=" + encodeURIComponent(callbackName);

  script.onerror = () => {
    cleanup();
    setConnection("Connection failed", "offline");
    showToast("Could not connect. Check the Apps Script deployment.");
  };

  timeout = setTimeout(() => {
    cleanup();
    setConnection("Timed out", "offline");
    showToast("The server did not respond within 15 seconds.");
  }, 15000);

  document.head.appendChild(script);
}

// 7. TOPICS AND STATISTICS
function renderTopicOptions() {
  ["flashTopic", "quizTopic"].forEach((id) => {
    const select = $(id);
    if (!select) return;

    const previous = select.value || "ALL";

    select.innerHTML =
      '<option value="ALL">All topics</option>' +
      topics.map((topic) =>
        `<option value="${escapeHTML(topic)}">${escapeHTML(topic)}</option>`
      ).join("");

    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    }
  });
}

function renderTopicGrid() {
  const grid = $("topicGrid");
  if (!grid) return;

  if (!topics.length) {
    grid.innerHTML = '<p class="muted">No topics available yet.</p>';
    return;
  }

  grid.innerHTML = topics.map((topic) => {
    const cards = flashcards.filter((card) => card.topic === topic).length;
    const quizCount = questions.filter((question) => question.topic === topic).length;

    return `
      <button class="topic-button" data-topic="${escapeHTML(topic)}">
        <span>${escapeHTML(topic)}</span>
        <span class="topic-count">${cards} cards · ${quizCount} questions</span>
      </button>
    `;
  }).join("");
}

function updateStatistics() {
  if ($("statCards")) $("statCards").textContent = flashcards.length;
  if ($("statQuizzes")) $("statQuizzes").textContent = quizHistory.length;

  const average = quizHistory.length
    ? Math.round(quizHistory.reduce((sum, item) => sum + item.percent, 0) / quizHistory.length)
    : 0;

  const best = quizHistory.length
    ? Math.max(...quizHistory.map((item) => item.percent))
    : 0;

  if ($("statAverage")) $("statAverage").textContent = average + "%";
  if ($("statBest")) $("statBest").textContent = best + "%";

  if ($("knownProgressText")) {
    $("knownProgressText").textContent = `${knownCards.size} marked known`;
  }

  if ($("knownProgressBar")) {
    const percent = flashcards.length
      ? Math.min(100, knownCards.size / flashcards.length * 100)
      : 0;

    $("knownProgressBar").style.width = percent + "%";
  }
}

// 8. NAVIGATION
function showView(mode) {
  const modes = ["overview", "flashcards", "quiz", "speed", "review"];
  if (!modes.includes(mode)) return;

  if (mode !== "speed" && speedTimer !== null) {
    stopSpeedTimer();
    showSpeedSetup();
  }

  modes.forEach((name) => {
    $(name + "View")?.classList.toggle("hidden", name !== mode);
  });

  document.querySelectorAll(".tab[data-mode]").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);

    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });

  if (mode === "review") renderMissedQuestions();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// 9. FLASHCARDS
function getFilteredCards() {
  const topic = $("flashTopic")?.value || "ALL";

  return topic === "ALL"
    ? [...flashcards]
    : flashcards.filter((card) => card.topic === topic);
}

function renderFlashcard() {
  filteredCards = getFilteredCards();

  if (!filteredCards.length) {
    if ($("flashText")) $("flashText").textContent = "No flashcards available for this topic.";
    if ($("flashCounter")) $("flashCounter").textContent = "0 / 0";
    if ($("flashTopicLabel")) $("flashTopicLabel").textContent = "NO CARDS";
    if ($("flashFaceLabel")) $("flashFaceLabel").textContent = "QUESTION";
    if ($("flipHint")) $("flipHint").textContent = "Choose another topic.";
    $("flashcard")?.classList.remove("flipped");

    if ($("markKnown")) $("markKnown").disabled = true;
    if ($("prevCard")) $("prevCard").disabled = true;
    if ($("nextCard")) $("nextCard").disabled = true;

    return;
  }

  flashIndex = Math.max(0, Math.min(flashIndex, filteredCards.length - 1));

  const card = filteredCards[flashIndex];
  const known = knownCards.has(getCardId(card));

  if ($("flashText")) {
    $("flashText").textContent = flashFlipped ? card.answer : card.question;
  }

  if ($("flashFaceLabel")) {
    $("flashFaceLabel").textContent = flashFlipped ? "ANSWER" : "QUESTION";
  }

  if ($("flashCounter")) {
    $("flashCounter").textContent = `${flashIndex + 1} / ${filteredCards.length}`;
  }

  if ($("flashTopicLabel")) {
    $("flashTopicLabel").textContent = card.topic.toUpperCase();
  }

  if ($("flipHint")) {
    $("flipHint").textContent = flashFlipped
      ? "Click to see question ↻"
      : "Click to reveal answer ↻";
  }

  $("flashcard")?.classList.toggle("flipped", flashFlipped);

  if ($("markKnown")) {
    $("markKnown").disabled = false;
    $("markKnown").textContent = known ? "Known ✓" : "I knew it ✓";
  }

  if ($("prevCard")) $("prevCard").disabled = false;
  if ($("nextCard")) $("nextCard").disabled = false;

  updateStatistics();
}

function flipFlashcard() {
  if (!filteredCards.length) return;
  flashFlipped = !flashFlipped;
  renderFlashcard();
}

function moveFlashcard(direction) {
  if (!filteredCards.length) return;

  flashIndex = (flashIndex + direction + filteredCards.length) % filteredCards.length;
  flashFlipped = false;
  renderFlashcard();
}

function shuffleFlashcards() {
  if (!filteredCards.length) {
    showToast("No flashcards to shuffle.");
    return;
  }

  const selectedTopic = $("flashTopic")?.value || "ALL";

  if (selectedTopic === "ALL") {
    flashcards = shuffleArray(flashcards);
  } else {
    const shuffled = shuffleArray(
      flashcards.filter((card) => card.topic === selectedTopic)
    );

    let index = 0;
    flashcards = flashcards.map((card) =>
      card.topic === selectedTopic ? shuffled[index++] : card
    );
  }

  flashIndex = 0;
  flashFlipped = false;
  renderFlashcard();
  showToast("Flashcards shuffled.");
}

function toggleKnownCard() {
  const card = filteredCards[flashIndex];
  if (!card) return;

  const id = getCardId(card);

  if (knownCards.has(id)) {
    knownCards.delete(id);
    showToast("Removed from known cards.");
  } else {
    knownCards.add(id);
    showToast("Marked as known!");
  }

  saveProgress();
  renderFlashcard();
}

// 10. PRACTICE QUIZ
function showQuizSetup() {
  $("quizSetup")?.classList.remove("hidden");
  $("quizPlay")?.classList.add("hidden");
  $("quizResult")?.classList.add("hidden");
}

function startQuiz() {
  const topic = $("quizTopic")?.value || "ALL";
  const count = Number($("quizCount")?.value || 10);

  const pool = questions.filter((question) =>
    topic === "ALL" || question.topic === topic
  );

  if (!pool.length) {
    showToast("No valid quiz questions are available.");
    return;
  }

  quizQuestions = shuffleArray(pool).slice(0, Math.min(count, pool.length));
  quizIndex = 0;
  quizScore = 0;
  quizAnswered = false;
  quizResults = [];

  $("quizSetup")?.classList.add("hidden");
  $("quizResult")?.classList.add("hidden");
  $("quizPlay")?.classList.remove("hidden");

  renderQuizQuestion();
}

function renderQuizQuestion() {
  const question = quizQuestions[quizIndex];
  if (!question) return finishQuiz();

  quizAnswered = false;

  if ($("quizHeading")) $("quizHeading").textContent = "Practice Quiz";
  if ($("quizTopicLabel")) $("quizTopicLabel").textContent = question.topic.toUpperCase();

  if ($("quizProgressText")) {
    $("quizProgressText").textContent = `Question ${quizIndex + 1} of ${quizQuestions.length}`;
  }

  if ($("quizProgressBar")) {
    $("quizProgressBar").style.width =
      ((quizIndex + 1) / quizQuestions.length * 100) + "%";
  }

  if ($("questionNumber")) {
    $("questionNumber").textContent = `QUESTION ${String(quizIndex + 1).padStart(2, "0")}`;
  }

  if ($("questionText")) $("questionText").textContent = question.question;
  if ($("quizLiveScore")) $("quizLiveScore").textContent = `Score: ${quizScore}`;

  if ($("answerOptions")) {
    $("answerOptions").innerHTML = question.options.map((option, index) => `
      <button class="answer-option" data-answer-index="${index}">
        <span class="option-letter">${String.fromCharCode(65 + index)}</span>
        <span>${escapeHTML(option)}</span>
      </button>
    `).join("");
  }

  $("answerFeedback")?.classList.add("hidden");

  if ($("nextQuestion")) {
    $("nextQuestion").disabled = true;
    $("nextQuestion").textContent = "Check answer";
  }
}

function chooseQuizAnswer(index) {
  if (quizAnswered) return;

  const question = quizQuestions[quizIndex];
  if (!question) return;

  quizAnswered = true;
  const correct = index === question.correctIndex;

  if (correct) quizScore++;

  quizResults.push({
    question,
    selectedIndex: index,
    correct,
    correctIndex: question.correctIndex
  });

  const id = getQuestionId(question);

  if (correct) {
    missedQuestions.delete(id);
  } else {
    const previous = missedQuestions.get(id) || { question, wrongCount: 0 };
    previous.question = question;
    previous.wrongCount++;
    missedQuestions.set(id, previous);
  }

  document.querySelectorAll("#answerOptions .answer-option").forEach((button, i) => {
    button.disabled = true;

    if (i === question.correctIndex) button.classList.add("correct");
    if (i === index && !correct) button.classList.add("incorrect");
  });

  const feedback = $("answerFeedback");

  if (feedback) {
    feedback.innerHTML = `
      <strong>${correct ? "Correct!" : "Not quite."}</strong>
      <p>Correct answer: ${escapeHTML(question.options[question.correctIndex])}</p>
      ${question.explanation ? `<p>${escapeHTML(question.explanation)}</p>` : ""}
    `;

    feedback.classList.remove("hidden", "good", "bad");
    feedback.classList.add(correct ? "good" : "bad");
  }

  if ($("quizLiveScore")) $("quizLiveScore").textContent = `Score: ${quizScore}`;

  if ($("nextQuestion")) {
    $("nextQuestion").disabled = false;
    $("nextQuestion").textContent =
      quizIndex === quizQuestions.length - 1 ? "See Results" : "Next Question →";
  }

  saveProgress();
  updateStatistics();
}

function nextQuizQuestion() {
  if (!quizAnswered) {
    showToast("Choose an answer first.");
    return;
  }

  quizIndex++;

  if (quizIndex >= quizQuestions.length) finishQuiz();
  else renderQuizQuestion();
}

function finishQuiz() {
  $("quizPlay")?.classList.add("hidden");
  $("quizResult")?.classList.remove("hidden");

  const total = quizQuestions.length;
  const percent = total ? Math.round(quizScore / total * 100) : 0;

  quizHistory.push({
    date: new Date().toISOString(),
    score: quizScore,
    total,
    percent
  });

  saveProgress();
  updateStatistics();

  const result = $("quizResult");
  if (!result) return;

  result.innerHTML = `
    <div class="result-hero">
      <div class="eyebrow">QUIZ COMPLETED</div>
      <div class="result-score">${percent}%</div>
      <p>You scored ${quizScore} out of ${total}.</p>
    </div>

    <div class="result-actions">
      <button class="primary-button" id="retryQuiz">Try Again</button>
      <button class="secondary-button" id="reviewMissed">Review Missed Questions</button>
      <button class="secondary-button" id="backOverview">Back to Overview</button>
    </div>

    <div class="result-review">
      <h3>Answer Review</h3>
      ${quizResults.map((item, index) => `
        <div class="result-item">
          <strong>${index + 1}. ${escapeHTML(item.question.question)}</strong>
          <p class="${item.correct ? "good-text" : "bad-text"}">
            Your answer: ${escapeHTML(item.question.options[item.selectedIndex])}
          </p>
          ${!item.correct ? `<p>Correct answer: ${escapeHTML(item.question.options[item.correctIndex])}</p>` : ""}
          ${item.question.explanation ? `<p>${escapeHTML(item.question.explanation)}</p>` : ""}
        </div>
      `).join("")}
    </div>
  `;

  $("retryQuiz")?.addEventListener("click", startQuiz);
  $("reviewMissed")?.addEventListener("click", () => showView("review"));
  $("backOverview")?.addEventListener("click", () => showView("overview"));
}

// 11. SPEED CHALLENGE
function stopSpeedTimer() {
  if (speedTimer !== null) {
    clearInterval(speedTimer);
    speedTimer = null;
  }
}

function showSpeedSetup() {
  stopSpeedTimer();
  $("speedSetup")?.classList.remove("hidden");
  $("speedPlay")?.classList.add("hidden");
  $("speedResult")?.classList.add("hidden");
}

function startSpeedChallenge() {
  if (!questions.length) {
    showToast("No valid quiz questions are available.");
    return;
  }

  stopSpeedTimer();

  speedQuestions = shuffleArray(questions);
  speedIndex = 0;
  speedScore = 0;
  speedAttempted = 0;
  speedAnswered = false;
  speedFinished = false;
  speedDeadline = Date.now() + SPEED_DURATION * 1000;

  $("speedSetup")?.classList.add("hidden");
  $("speedResult")?.classList.add("hidden");
  $("speedPlay")?.classList.remove("hidden");

  renderSpeedQuestion();
  updateSpeedTimer();

  speedTimer = setInterval(updateSpeedTimer, 200);
}

function updateSpeedTimer() {
  const remaining = Math.max(0, Math.ceil((speedDeadline - Date.now()) / 1000));

  if ($("timerReadout")) $("timerReadout").textContent = remaining + "s";
  if ($("timerBar")) $("timerBar").style.width = remaining / SPEED_DURATION * 100 + "%";

  if (remaining <= 0 && !speedFinished) finishSpeedChallenge();
}

function renderSpeedQuestion() {
  if (speedFinished) return;

  if (!speedQuestions.length) return finishSpeedChallenge();

  if (speedIndex >= speedQuestions.length) {
    speedQuestions = shuffleArray(questions);
    speedIndex = 0;
  }

  const question = speedQuestions[speedIndex];
  speedAnswered = false;

  if ($("speedQuestionNumber")) {
    $("speedQuestionNumber").textContent = `QUESTION ${speedAttempted + 1}`;
  }

  if ($("speedQuestionText")) $("speedQuestionText").textContent = question.question;
  if ($("speedScore")) $("speedScore").textContent = `Score: ${speedScore}`;

  if ($("speedOptions")) {
    $("speedOptions").innerHTML = question.options.map((option, index) => `
      <button class="answer-option" data-speed-index="${index}">
        <span class="option-letter">${String.fromCharCode(65 + index)}</span>
        <span>${escapeHTML(option)}</span>
      </button>
    `).join("");
  }

  $("speedFeedback")?.classList.add("hidden");
  $("speedNext")?.classList.add("hidden");
}

function chooseSpeedAnswer(index) {
  if (speedAnswered || speedFinished) return;

  if (Date.now() >= speedDeadline) {
    finishSpeedChallenge();
    return;
  }

  const question = speedQuestions[speedIndex];
  if (!question) return;

  speedAnswered = true;
  speedAttempted++;

  const correct = index === question.correctIndex;
  if (correct) speedScore++;

  document.querySelectorAll("#speedOptions .answer-option").forEach((button, i) => {
    button.disabled = true;

    if (i === question.correctIndex) button.classList.add("correct");
    if (i === index && !correct) button.classList.add("incorrect");
  });

  const feedback = $("speedFeedback");

  if (feedback) {
    feedback.textContent = correct
      ? "Correct!"
      : `Correct answer: ${question.options[question.correctIndex]}`;

    feedback.classList.remove("hidden", "good", "bad");
    feedback.classList.add(correct ? "good" : "bad");
  }

  if ($("speedScore")) $("speedScore").textContent = `Score: ${speedScore}`;
  $("speedNext")?.classList.remove("hidden");
}

function nextSpeedQuestion() {
  if (!speedAnswered) return;
  speedIndex++;
  renderSpeedQuestion();
}

function finishSpeedChallenge() {
  if (speedFinished) return;

  speedFinished = true;
  stopSpeedTimer();

  $("speedPlay")?.classList.add("hidden");
  $("speedResult")?.classList.remove("hidden");

  const percent = speedAttempted
    ? Math.round(speedScore / speedAttempted * 100)
    : 0;

  const result = $("speedResult");
  if (!result) return;

  result.innerHTML = `
    <div class="result-hero">
      <div class="eyebrow">TIME'S UP!</div>
      <div class="result-score">${speedScore}</div>
      <p>Correct answers out of ${speedAttempted} attempted.</p>
      <p>Accuracy: ${percent}%</p>
    </div>
    <div class="result-actions">
      <button class="primary-button" id="playSpeedAgain">Play Again</button>
      <button class="secondary-button" id="speedBackOverview">Back to Overview</button>
    </div>
  `;

  $("playSpeedAgain")?.addEventListener("click", startSpeedChallenge);
  $("speedBackOverview")?.addEventListener("click", () => showView("overview"));
}

// 12. MISSED QUESTIONS
function renderMissedQuestions() {
  const container = $("reviewContent");
  if (!container) return;

  const entries = [...missedQuestions.values()];

  if (!entries.length) {
    container.innerHTML = `
      <p class="muted">No missed questions yet. Complete a quiz to build your review list.</p>
    `;
    return;
  }

  container.innerHTML = `
    <p class="muted">${entries.length} question(s) to review.</p>

    ${entries.map((entry, index) => `
      <article class="result-item">
        <div class="review-topic">
          ${escapeHTML(entry.question.topic)} · Missed ${entry.wrongCount} time(s)
        </div>
        <strong>${index + 1}. ${escapeHTML(entry.question.question)}</strong>
        <p>Correct answer: ${
          escapeHTML(entry.question.options[entry.question.correctIndex])
        }</p>
        ${entry.question.explanation ? `<p>${escapeHTML(entry.question.explanation)}</p>` : ""}
      </article>
    `).join("")}

    <div class="result-actions">
      <button class="primary-button" id="practiceMissed">Practice These Questions</button>
      <button class="secondary-button" id="clearMissed">Clear Review List</button>
    </div>
  `;

  $("practiceMissed")?.addEventListener("click", () => {
    const ids = new Set(
      [...missedQuestions.values()].map((entry) => getQuestionId(entry.question))
    );

    quizQuestions = shuffleArray(
      questions.filter((question) => ids.has(getQuestionId(question)))
    );

    if (!quizQuestions.length) {
      showToast("Those questions are no longer available.");
      return;
    }

    quizIndex = 0;
    quizScore = 0;
    quizAnswered = false;
    quizResults = [];

    showView("quiz");
    $("quizSetup")?.classList.add("hidden");
    $("quizResult")?.classList.add("hidden");
    $("quizPlay")?.classList.remove("hidden");

    renderQuizQuestion();
  });

  $("clearMissed")?.addEventListener("click", () => {
    if (!confirm("Clear all missed questions saved in this browser?")) return;

    missedQuestions.clear();
    saveProgress();
    renderMissedQuestions();
    showToast("Review list cleared.");
  });
}

// 13. DARK MODE
function initializeTheme() {
  let dark = false;

  try {
    dark = localStorage.getItem(STORAGE_KEY + "_dark") === "true";
  } catch (_) {}

  document.body.classList.toggle("dark", dark);

  const button = $("themeToggle");

  if (button) {
    button.textContent = dark ? "☀" : "◐";
    button.setAttribute(
      "aria-label",
      dark ? "Switch to light mode" : "Switch to dark mode"
    );
  }
}

function toggleTheme() {
  const dark = document.body.classList.toggle("dark");
  const button = $("themeToggle");

  if (button) {
    button.textContent = dark ? "☀" : "◐";
    button.setAttribute(
      "aria-label",
      dark ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  try {
    localStorage.setItem(STORAGE_KEY + "_dark", String(dark));
  } catch (_) {}
}

// 14. EVENT LISTENERS
function initializeEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.mode));
  });

  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.go;
      showView(mode);
      if (mode === "flashcards") renderFlashcard();
    });
  });

  $("topicGrid")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-topic]");
    if (!button) return;

    if ($("flashTopic")) $("flashTopic").value = button.dataset.topic;

    flashIndex = 0;
    flashFlipped = false;
    showView("flashcards");
    renderFlashcard();
  });

  $("flashTopic")?.addEventListener("change", () => {
    flashIndex = 0;
    flashFlipped = false;
    renderFlashcard();
  });

  $("flashcard")?.addEventListener("click", flipFlashcard);
  $("prevCard")?.addEventListener("click", () => moveFlashcard(-1));
  $("nextCard")?.addEventListener("click", () => moveFlashcard(1));
  $("markKnown")?.addEventListener("click", toggleKnownCard);
  $("shuffleCards")?.addEventListener("click", shuffleFlashcards);

  $("startQuiz")?.addEventListener("click", startQuiz);
  $("nextQuestion")?.addEventListener("click", nextQuizQuestion);

  $("answerOptions")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-answer-index]");
    if (button) chooseQuizAnswer(Number(button.dataset.answerIndex));
  });

  $("startSpeed")?.addEventListener("click", startSpeedChallenge);
  $("speedNext")?.addEventListener("click", nextSpeedQuestion);

  $("speedOptions")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-speed-index]");
    if (button) chooseSpeedAnswer(Number(button.dataset.speedIndex));
  });

  $("themeToggle")?.addEventListener("click", toggleTheme);
  window.addEventListener("beforeunload", stopSpeedTimer);
}

// 15. START THE APPLICATION
function initializeApp() {
  loadSavedProgress();
  initializeTheme();
  initializeEvents();

  renderFlashcard();
  updateStatistics();
  renderMissedQuestions();

  loadStudyMaterials();
}

document.addEventListener("DOMContentLoaded", initializeApp);
