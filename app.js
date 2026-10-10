"use strict";

/*
 * BuCor Exam Review
 * File: app.js
 *
 * Required backend response:
 * {
 *   "ok": true,
 *   "topics": ["English", "Mathematics"],
 *   "flashcards": [
 *     {
 *       "topic": "English",
 *       "question": "What is a noun?",
 *       "answer": "A word that names a person, place, thing, or idea."
 *     }
 *   ],
 *   "questions": [
 *     {
 *       "topic": "English",
 *       "question": "Which word is a noun?",
 *       "options": ["Run", "Beautiful", "Teacher", "Quickly"],
 *       "answer": 2,
 *       "explanation": "Teacher names a person."
 *     }
 *   ]
 * }
 */

// =====================================================
// 1. CONFIGURATION
// =====================================================

// Replace this with your deployed Google Apps Script URL.
// It should end in /exec, not /dev.
const API_URL = "https://script.google.com/macros/s/AKfycbyewnNfvmVW76tos2yOO5bThGKvvuZdBPDFKYSwQhoiqhy6KAe-EQkGAy7WqAdb5PcZ4g/exec";

const SPEED_DURATION = 60;
const STORAGE_KEY = "bucorExamReview_v1";

// =====================================================
// 2. APPLICATION STATE
// =====================================================

let flashcards = [];
let questions = [];
let topics = [];

let currentMode = "overview";
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
let speedAnswered = false;
let speedFinished = false;
let speedDeadline = 0;
let speedTimer = null;
let speedAttempted = 0;

let quizHistory = [];
let missedQuestions = new Map();

let toastTimeout = null;

// =====================================================
// 3. HELPERS
// =====================================================

const $ = (id) => document.getElementById(id);

function shuffleArray(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function showToast(message) {
  const toast = $("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimeout);

  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

function setConnection(message, status = "") {
  const element = $("connectionStatus");
  if (!element) return;

  element.textContent = message;
  element.classList.remove("online", "offline");

  if (status) {
    element.classList.add(status);
  }
}

function showView(mode) {
  const validModes = [
    "overview",
    "flashcards",
    "quiz",
    "speed",
    "review"
  ];

  if (!validModes.includes(mode)) return;

  // Stop a running speed challenge when leaving its screen.
  if (mode !== "speed" && speedTimer !== null) {
    stopSpeedTimer();
    showSpeedSetup();
  }

  currentMode = mode;

  validModes.forEach((name) => {
    const view = $(name + "View");
    if (view) {
      view.classList.toggle("hidden", name !== mode);
    }
  });

  document.querySelectorAll(".tab[data-mode]").forEach((tab) => {
    const active = tab.dataset.mode === mode;

    tab.classList.toggle("active", active);

    if (active) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  });

  if (mode === "review") {
    renderMissedQuestions();
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadSavedProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const saved = JSON.parse(raw);

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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        knownCards: [...knownCards],
        quizHistory,
        missedQuestions: [...missedQuestions.entries()]
      })
    );
  } catch (error) {
    console.warn("Could not save progress:", error);
    showToast("Progress could not be saved in this browser.");
  }
}

function getQuestionId(question) {
  return [
    question.topic,
    question.question,
    JSON.stringify(question.options || [])
  ].join("::");
}

function getCardId(card) {
  return [card.topic, card.question, card.answer].join("::");
}

function getCorrectIndex(question) {
  const answer = question.answer ??
    question.correctAnswer ??
    question.correct;

  if (typeof answer === "number" && Number.isInteger(answer)) {
    // Numeric answers are assumed to be zero-based option indexes.
    return answer;
  }

  if (typeof answer === "string") {
    const normalized = answer.trim();

    // Support "A", "B", "C", "D" answer keys.
    if (/^[A-D]$/i.test(normalized)) {
      return normalized.toUpperCase().charCodeAt(0) - 65;
    }

    // Or a full answer matching one of the options.
    const matchingIndex = question.options.findIndex(
      (option) =>
        String(option).trim().toLowerCase() ===
        normalized.toLowerCase()
    );

    if (matchingIndex >= 0) return matchingIndex;

    // Also support numeric strings such as "2".
    if (/^\d+$/.test(normalized)) {
      return Number(normalized);
    }
  }

  return -1;
}

function normalizeCard(card) {
  return {
    ...card,
    topic: String(card.topic || card.subject || "General"),
    question: String(
      card.question || card.front || card.term || ""
    ),
    answer: String(
      card.answer || card.back || card.definition || ""
    )
  };
}

function normalizeQuestion(question) {
  const options = Array.isArray(question.options)
    ? question.options
    : Array.isArray(question.choices)
      ? question.choices
      : [];

  const normalized = {
    ...question,
    topic: String(question.topic || question.subject || "General"),
    question: String(question.question || question.text || ""),
    options: options.map((option) => String(option)),
    explanation: String(question.explanation || "")
  };

  normalized.correctIndex = getCorrectIndex(normalized);

  return normalized;
}

// =====================================================
// 4. LOAD STUDY MATERIALS
// =====================================================

function loadStudyMaterials() {
  if (
    !API_URL ||
    API_URL === "PASTE_YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL_HERE"
  ) {
    setConnection("API URL needed", "offline");

    if ($("contentSummary")) {
      $("contentSummary").textContent =
        "Configure your Apps Script URL to load study materials.";
    }

    if ($("topicGrid")) {
      $("topicGrid").innerHTML =
        '<p class="muted">Your study materials have not been connected yet.</p>';
    }

    if ($("flashText")) {
      $("flashText").textContent = "Connect the study database first.";
    }

    showToast("Add your Google Apps Script URL in app.js.");
    return;
  }

  setConnection("Connecting...");

  // JSONP lets a static GitHub Pages site request data from
  // an Apps Script endpoint that explicitly supports callbacks.
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

    if (script) {
      script.remove();
    }

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
        throw new Error(
          data?.error || "The server returned an error."
        );
      }

      const cardData = Array.isArray(data.flashcards)
        ? data.flashcards
        : [];

      const questionData = Array.isArray(data.questions)
        ? data.questions
        : [];

      flashcards = cardData
        .map(normalizeCard)
        .filter((card) => card.question && card.answer);

      questions = questionData
        .map(normalizeQuestion)
        .filter((question) =>
          question.question &&
          question.options.length >= 2 &&
          question.correctIndex >= 0 &&
          question.correctIndex < question.options.length
        );

      const receivedTopics = Array.isArray(data.topics)
        ? data.topics
        : [];

      topics = [
        ...new Set([
          ...receivedTopics.map((topic) =>
            typeof topic === "string"
              ? topic
              : String(topic.name || topic.topic || "")
          ),
          ...flashcards.map((card) => card.topic),
          ...questions.map((question) => question.topic)
        ])
      ].filter(Boolean).sort((a, b) => a.localeCompare(b));

      renderTopicOptions();
      renderTopicGrid();
      updateStatistics();
      renderFlashcard();

      if ($("contentSummary")) {
        $("contentSummary").textContent =
          `${flashcards.length} flashcards · ` +
          `${questions.length} practice questions`;
      }

      setConnection("Connected", "online");

      if (flashcards.length === 0 && questions.length === 0) {
        showToast("Connected, but no study materials were found.");
      } else {
        showToast("Study materials loaded successfully.");
      }
    } catch (error) {
      console.error("Study data error:", error);
      setConnection("Data error", "offline");
      showToast("Could not read study data. Check the API format.");
    }
  };

  const separator = API_URL.includes("?") ? "&" : "?";

  script = document.createElement("script");
  script.src =
    API_URL + separator +
    "callback=" + encodeURIComponent(callbackName);

  script.onerror = function () {
    cleanup();
    setConnection("Connection failed", "offline");
    showToast("Could not connect. Check your Apps Script URL.");
  };

  timeout = setTimeout(() => {
    cleanup();
    setConnection("Timed out", "offline");
    showToast("The server did not respond. Check JSONP support.");
  }, 15000);

  document.head.appendChild(script);
}

// =====================================================
// 5. TOPICS AND STATISTICS
// =====================================================

function renderTopicOptions() {
  ["flashTopic", "quizTopic"].forEach((id) => {
    const select = $(id);
    if (!select) return;

    const previousValue = select.value || "ALL";

    select.innerHTML =
      '<option value="ALL">All topics</option>' +
      topics.map((topic) =>
        `<option value="${escapeHTML(topic)}">` +
        `${escapeHTML(topic)}</option>`
      ).join("");

    if ([...select.options].some(
      (option) => option.value === previousValue
    )) {
      select.value = previousValue;
    }
  });
}

function renderTopicGrid() {
  const grid = $("topicGrid");
  if (!grid) return;

  if (topics.length === 0) {
    grid.innerHTML =
      '<p class="muted">No topics available yet.</p>';
    return;
  }

  grid.innerHTML = topics.map((topic) => {
    const cardCount = flashcards.filter(
      (card) => card.topic === topic
    ).length;

    const questionCount = questions.filter(
      (question) => question.topic === topic
    ).length;

    return `
      <button class="topic-button"
        data-topic="${escapeHTML(topic)}">
        <span>${escapeHTML(topic)}</span>
        <span class="topic-count">
          ${cardCount} cards · ${questionCount} questions
        </span>
      </button>
    `;
  }).join("");
}

function updateStatistics() {
  const totalCards = $("statCards");
  if (totalCards) totalCards.textContent = flashcards.length;

  const totalQuizzes = $("statQuizzes");
  if (totalQuizzes) totalQuizzes.textContent = quizHistory.length;

  const average = quizHistory.length
    ? Math.round(
        quizHistory.reduce((sum, item) => sum + item.percent, 0) /
        quizHistory.length
      )
    : 0;

  const best = quizHistory.length
    ? Math.max(...quizHistory.map((item) => item.percent))
    : 0;

  if ($("statAverage")) {
    $("statAverage").textContent = average + "%";
  }

  if ($("statBest")) {
    $("statBest").textContent = best + "%";
  }

  if ($("knownProgressText")) {
    $("knownProgressText").textContent =
      `${knownCards.size} marked known`;
  }

  const progressBar = $("knownProgressBar");

  if (progressBar) {
    const percent = flashcards.length
      ? Math.min(100, (knownCards.size / flashcards.length) * 100)
      : 0;

    progressBar.style.width = percent + "%";
  }
}

// =====================================================
// 6. FLASHCARDS
// =====================================================

function getFilteredCards() {
  const selectedTopic = $("flashTopic")?.value || "ALL";

  return selectedTopic === "ALL"
    ? [...flashcards]
    : flashcards.filter((card) => card.topic === selectedTopic);
}

function renderFlashcard() {
  filteredCards = getFilteredCards();

  if (filteredCards.length === 0) {
    if ($("flashText")) {
      $("flashText").textContent = "No flashcards for this topic.";
    }

    if ($("flashCounter")) {
      $("flashCounter").textContent = "0 / 0";
    }

    if ($("flashTopicLabel")) {
      $("flashTopicLabel").textContent = "NO CARDS";
    }

    if ($("flashFaceLabel")) {
      $("flashFaceLabel").textContent = "QUESTION";
    }

    if ($("flipHint")) {
      $("flipHint").textContent = "Choose another topic.";
    }

    $("flashcard")?.classList.remove("flipped");

    if ($("markKnown")) $("markKnown").disabled = true;
    if ($("prevCard")) $("prevCard").disabled = true;
    if ($("nextCard")) $("nextCard").disabled = true;

    updateStatistics();
    return;
  }

  flashIndex = Math.max(
    0,
    Math.min(flashIndex, filteredCards.length - 1)
  );

  const card = filteredCards[flashIndex];
  const known = knownCards.has(getCardId(card));

  if ($("flashText")) {
    $("flashText").textContent =
      flashFlipped ? card.answer : card.question;
  }

  if ($("flashFaceLabel")) {
    $("flashFaceLabel").textContent =
      flashFlipped ? "ANSWER" : "QUESTION";
  }

  if ($("flashCounter")) {
    $("flashCounter").textContent =
      `${flashIndex + 1} / ${filteredCards.length}`;
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
    $("markKnown").textContent = known
      ? "Known ✓"
      : "I knew it ✓";
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

  flashIndex =
    (flashIndex + direction + filteredCards.length) %
    filteredCards.length;

  flashFlipped = false;
  renderFlashcard();
}

function shuffleFlashcards() {
  if (!filteredCards.length) {
    showToast("No flashcards to shuffle.");
    return;
  }

  const
