const COMMUNITY_ID = "kennyverse";
const ZEALY_LEADERBOARD_URL = "https://zealy.io/cw/kennyverse/leaderboard";
const REFRESH_SECONDS = 60;
const API_BASE = window.KENNY_ZEALY_API_BASE || "/api/zealy";
const SESSION_TOKEN_KEY = "kenny_airdrop_session_token";
const WALLET_KEY = "kenny_airdrop_wallet";

const TASKS = {
  oneTime: [
    { id: "join-telegram", name: "Join Telegram", points: 1000 },
    { id: "follow-x", name: "Follow X", points: 1000 },
    { id: "retweet-pinned", name: "Retweet pinned post", points: 1000 },
  ],
  daily: [
    { id: "comment-x-post", name: "Comment on $KENNY X post", points: 1000 },
    { id: "retweet-daily", name: "Retweet daily post", points: 1000 },
    { id: "submit-meme", name: "Submit Kenny meme", points: 2000 },
    { id: "tag-friends", name: "Tag 2 friends on X", points: 1000 },
    { id: "fifth-task", name: "Daily challange", points: 1000 },
  ],
};

const fallbackParticipants = [
  {
    id: "u1",
    username: "KennyKing",
    wallet: "0x14d8...92af",
    points: 42000,
    invites: 4,
    completedTasks: ["join-telegram", "follow-x", "retweet-pinned", "comment-x-post", "retweet-daily", "submit-meme"],
    meme: { title: "Kenny dollar meme", status: "pending" },
  },
  {
    id: "u2",
    username: "GoldPaws",
    wallet: "0x8fa3...51db",
    points: 36500,
    invites: 3,
    completedTasks: ["join-telegram", "follow-x", "comment-x-post", "retweet-daily", "tag-friends"],
    meme: { title: "Moon paws poster", status: "approved" },
  },
  {
    id: "u3",
    username: "KennyVerse",
    wallet: "0x65ad...30ce",
    points: 31000,
    invites: 2,
    completedTasks: ["join-telegram", "follow-x", "retweet-pinned", "submit-meme", "fifth-task"],
    meme: { title: "Kenny raid graphic", status: "pending" },
  },
  {
    id: "u4",
    username: "PounceClub",
    wallet: "0x773c...fd81",
    points: 25500,
    invites: 1,
    completedTasks: ["join-telegram", "retweet-pinned", "comment-x-post"],
    meme: { title: "Pounce season meme", status: "rejected" },
  },
];

const $ = (selector) => document.querySelector(selector);
const tagline = $("#tagline");
const taglineButtons = document.querySelectorAll("[data-tagline]");
const gatedLinks = document.querySelectorAll(".signup-gated-link");

let participants = loadLocalParticipants();
let selectedUserId = participants[0]?.id || null;
let refreshRemaining = REFRESH_SECONDS;

const elements = {
  apiStatus: $("#apiStatus"),
  leaderboardBody: $("#leaderboardBody"),
  participantsBody: $("#participantsBody"),
  memeList: $("#memeList"),
  pendingMemeCount: $("#pendingMemeCount"),
  leaderboardSearch: $("#leaderboardSearch"),
  refreshButton: $("#refreshButton"),
  refreshCountdown: $("#refreshCountdown"),
  metricParticipants: $("#metricParticipants"),
  metricPoints: $("#metricPoints"),
  metricInvites: $("#metricInvites"),
  lookupForm: $("#userLookupForm"),
  lookupInput: $("#userLookupInput"),
  dashboardName: $("#dashboardName"),
  dashboardWallet: $("#dashboardWallet"),
  dashboardRank: $("#dashboardRank"),
  dashboardPoints: $("#dashboardPoints"),
  dashboardInvites: $("#dashboardInvites"),
  dashboardCompleted: $("#dashboardCompleted"),
  referralLink: $("#referralLink"),
  copyReferralButton: $("#copyReferralButton"),
  oneTimeTasks: $("#oneTimeTasks"),
  dailyTasks: $("#dailyTasks"),
  awardForm: $("#awardForm"),
  exportButton: $("#exportButton"),
  signupForm: $("#signupForm"),
  signupUsername: $("#signupUsername"),
  signupWallet: $("#signupWallet"),
  signupX: $("#signupX"),
  signupTelegram: $("#signupTelegram"),
  signupWelcome: $("#signupWelcome"),
  startSignupButton: $("#startSignupButton"),
  signupLoading: $("#signupLoading"),
  loadingStatus: $("#loadingStatus"),
  profilePhotoInput: $("#profilePhotoInput"),
  profilePhotoPreview: $("#profilePhotoPreview"),
  airdropSection: $("#airdrop"),
};

taglineButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const { tagline: nextTagline } = button.dataset;

    if (!nextTagline || !tagline) {
      return;
    }

    tagline.textContent = nextTagline;
  });
});

gatedLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    if (localStorage.getItem(SESSION_TOKEN_KEY)) {
      return;
    }

    event.preventDefault();
    window.location.href = `signup.html?redirect=${encodeURIComponent(link.getAttribute("href"))}`;
  });
});

if (elements.startSignupButton) {
  elements.startSignupButton.addEventListener("click", () => {
    speakWelcome();
    elements.signupWelcome.classList.add("welcome-hidden");
  });
}

async function saveBackendSession({ token, account }) {
  localStorage.setItem(SESSION_TOKEN_KEY, token);
  localStorage.setItem(WALLET_KEY, account.wallet);

  const participant = createSignupParticipant(account);
  participant.id = account.wallet;
  selectedUserId = participant.id;
  saveLocalParticipants();
}

async function loadCurrentAccount() {
  const wallet = localStorage.getItem(WALLET_KEY);

  if (!wallet) {
    return null;
  }

  return participants.find((participant) => participant.wallet === wallet) || null;
}

async function createManualWalletAccount({ username, wallet, xUsername, telegramUsername }) {
  const account = createSignupParticipant({ username, wallet, xUsername, telegramUsername });
  saveLocalParticipants();
  localStorage.setItem(SESSION_TOKEN_KEY, "device-local-account");
  localStorage.setItem(WALLET_KEY, account.wallet);
  selectedUserId = account.id;
  return account;
}

function loadLocalParticipants() {
  const saved = localStorage.getItem("kenny_airdrop_participants");

  if (!saved) {
    return fallbackParticipants;
  }

  try {
    return JSON.parse(saved);
  } catch (error) {
    return fallbackParticipants;
  }
}

function saveLocalParticipants() {
  localStorage.setItem("kenny_airdrop_participants", JSON.stringify(participants));
}

function createSignupParticipant({ username, wallet, xUsername, telegramUsername }) {
  const existing = participants.find((participant) => {
    return (
      participant.username.toLowerCase() === String(username).toLowerCase() ||
      String(participant.wallet || "").toLowerCase() === wallet.toLowerCase()
    );
  });

  if (existing) {
    existing.id = wallet;
    existing.username = username;
    existing.wallet = wallet;
    existing.xUsername = xUsername;
    existing.telegramUsername = telegramUsername;
    return existing;
  }

  const newParticipant = {
    id: wallet,
    username,
    wallet,
    xUsername,
    telegramUsername,
    points: 0,
    invites: 0,
    completedTasks: [],
    meme: { title: "No meme submission", status: "pending" },
    signedUpAt: new Date().toISOString(),
  };

  participants.push(newParticipant);
  return newParticipant;
}

function speakWelcome() {
  if (!("speechSynthesis" in window)) {
    return;
  }

  window.speechSynthesis.cancel();
  const message = new SpeechSynthesisUtterance(
    ""
  );
  message.rate = 0.85;
  message.pitch = 0.02;
  window.speechSynthesis.speak(message);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runSignupLoading() {
  const loadingMessages = [
    "Confirming signup details...",
    "Checking wallet format...",
    "Preparing local account record...",
    "Loading Kennyverse dashboard...",
    "Everything looks ready.",
  ];

  elements.signupLoading.hidden = false;

  for (let index = 0; index < loadingMessages.length; index += 1) {
    elements.loadingStatus.textContent = loadingMessages[index];
    await wait(2000);
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function sortParticipants(list) {
  return [...list].sort((a, b) => Number(b.points || 0) - Number(a.points || 0));
}

function getRankedParticipants() {
  return sortParticipants(participants).map((participant, index) => ({
    ...participant,
    rank: index + 1,
  }));
}

function normalizeZealyParticipant(item, index) {
  const user = item.user || item.member || item.profile || item;
  const username =
    user.username ||
    user.name ||
    user.displayName ||
    user.twitterUsername ||
    `KennyUser${index + 1}`;

  return {
    id: String(user.id || item.id || username),
    username,
    wallet: user.wallet || user.walletAddress || item.wallet || item.walletAddress || "Not connected",
    points: Number(item.points || item.xp || item.score || item.totalPoints || 0),
    invites: Number(item.invites || item.referrals || item.referralCount || 0),
    completedTasks: item.completedTasks || item.completedQuestIds || [],
    meme: item.meme || { title: "No meme submission", status: "pending" },
  };
}

async function fetchZealyLeaderboard() {
  const endpoint = `${API_BASE}/communities/${COMMUNITY_ID}/leaderboard`;
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`Zealy proxy returned ${response.status}`);
  }

  const data = await response.json();
  const list = data.leaderboard || data.participants || data.items || data.data || data;

  if (!Array.isArray(list)) {
    throw new Error("Zealy proxy response did not contain a leaderboard array");
  }

  return list.map(normalizeZealyParticipant);
}

async function refreshLeaderboard() {
  elements.apiStatus.textContent = "Refreshing...";

  try {
    participants = await fetchZealyLeaderboard();
    saveLocalParticipants();
    elements.apiStatus.textContent = "Live Zealy data";
  } catch (error) {
    elements.apiStatus.textContent = "Demo data until Zealy proxy is connected";
  }

  refreshRemaining = REFRESH_SECONDS;
  elements.refreshCountdown.textContent = refreshRemaining;
  renderAll();
}

function filteredParticipants() {
  const query = elements.leaderboardSearch.value.trim().toLowerCase();
  const ranked = getRankedParticipants();

  if (!query) {
    return ranked;
  }

  return ranked.filter((participant) => {
    return `${participant.username} ${participant.wallet}`.toLowerCase().includes(query);
  });
}

function renderLeaderboard() {
  const rows = filteredParticipants()
    .map((participant) => {
      return `
        <tr>
          <td>#${participant.rank}</td>
          <td>${participant.username}</td>
          <td>${formatNumber(participant.points)}</td>
          <td>${formatNumber(participant.invites)}</td>
        </tr>
      `;
    })
    .join("");

  elements.leaderboardBody.innerHTML = rows || `<tr><td colspan="4">No participants found.</td></tr>`;
}

function renderMetrics() {
  const totalPoints = participants.reduce((sum, participant) => sum + Number(participant.points || 0), 0);
  const totalInvites = participants.reduce((sum, participant) => sum + Number(participant.invites || 0), 0);

  elements.metricParticipants.textContent = formatNumber(participants.length);
  elements.metricPoints.textContent = formatNumber(totalPoints);
  elements.metricInvites.textContent = formatNumber(totalInvites);
}

function renderParticipantsTable() {
  elements.participantsBody.innerHTML = getRankedParticipants()
    .map((participant) => {
      return `
        <tr>
          <td>${participant.username}</td>
          <td>${participant.wallet || "Not connected"}</td>
          <td>${formatNumber(participant.points)}</td>
          <td>${formatNumber(participant.invites)}</td>
        </tr>
      `;
    })
    .join("");
}

function getSelectedUser() {
  return getRankedParticipants().find((participant) => participant.id === selectedUserId);
}

function renderDashboard() {
  const user = getSelectedUser();

  if (!user) {
    return;
  }

  const completedCount = user.completedTasks?.length || 0;
  const totalTasks = TASKS.oneTime.length + TASKS.daily.length;
  const referralSlug = encodeURIComponent(user.username || user.id);

  elements.dashboardName.textContent = user.username;
  elements.dashboardWallet.textContent = user.wallet || "Wallet not connected";
  elements.dashboardRank.textContent = `#${user.rank}`;
  elements.dashboardPoints.textContent = formatNumber(user.points);
  elements.dashboardInvites.textContent = formatNumber(user.invites);
  elements.dashboardCompleted.textContent = `${completedCount}/${totalTasks}`;
  elements.referralLink.value = `${ZEALY_LEADERBOARD_URL}?ref=${referralSlug}`;
  elements.profilePhotoPreview.src = user.profilePhoto || "image/kenny official.jpg";
  renderTasksForUser(user);
}

function renderTaskGroup(container, tasks, completedTasks) {
  container.innerHTML = tasks
    .map((task) => {
      const complete = completedTasks.includes(task.id);

      return `
        <div class="task-row">
          <span>
            ${task.name}
            <span class="task-state ${complete ? "complete" : "pending"}">
              ${complete ? "Completed" : "Pending"}
            </span>
          </span>
          <strong>${formatNumber(task.points)} pts</strong>
        </div>
      `;
    })
    .join("");
}

function renderTasksForUser(user) {
  const completedTasks = user?.completedTasks || [];
  renderTaskGroup(elements.oneTimeTasks, TASKS.oneTime, completedTasks);
  renderTaskGroup(elements.dailyTasks, TASKS.daily, completedTasks);
}

function renderMemeSubmissions() {
  const memeParticipants = getRankedParticipants().filter((participant) => participant.meme);
  const pendingCount = memeParticipants.filter((participant) => participant.meme.status === "pending").length;

  elements.pendingMemeCount.textContent = `${pendingCount} pending`;
  elements.memeList.innerHTML = memeParticipants
    .map((participant) => {
      return `
        <div class="meme-item">
          <header>
            <strong>${participant.meme.title}</strong>
            <span class="status-pill">${participant.meme.status}</span>
          </header>
          <span class="muted-text">${participant.username}</span>
          <div class="meme-actions">
            <button class="button button-secondary" type="button" data-meme-action="approved" data-user-id="${participant.id}">
              Approve
            </button>
            <button class="button button-secondary danger-button" type="button" data-meme-action="rejected" data-user-id="${participant.id}">
              Reject
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderAll() {
  renderLeaderboard();
  renderMetrics();
  renderParticipantsTable();
  renderDashboard();
  renderMemeSubmissions();
}

function selectUserByQuery(query) {
  const normalizedQuery = query.trim().toLowerCase();

  return getRankedParticipants().find((participant) => {
    return (
      participant.username.toLowerCase() === normalizedQuery ||
      String(participant.wallet || "").toLowerCase() === normalizedQuery
    );
  });
}

function awardPoints(username, points, reason) {
  const participant = participants.find((item) => item.username.toLowerCase() === username.toLowerCase());

  if (!participant) {
    alert("Participant not found. Sync from Zealy or check the username.");
    return;
  }

  participant.points = Number(participant.points || 0) + Number(points);
  participant.lastManualAward = { points: Number(points), reason, awardedAt: new Date().toISOString() };
  saveLocalParticipants();
  renderAll();
}

function exportCsv() {
  const headers = ["Rank", "Username", "Wallet", "Total Points", "Invites", "Meme Status"];
  const rows = getRankedParticipants().map((participant) => [
    participant.rank,
    participant.username,
    participant.wallet || "",
    participant.points || 0,
    participant.invites || 0,
    participant.meme?.status || "",
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kenny-airdrop-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

if (elements.signupForm) {
  elements.signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      elements.signupForm.hidden = true;
      await runSignupLoading();
      const account = await createManualWalletAccount({
        username: elements.signupUsername.value.trim(),
        wallet: elements.signupWallet.value.trim(),
        xUsername: elements.signupX.value.trim(),
        telegramUsername: elements.signupTelegram.value.trim(),
      });
      const redirectTarget = new URLSearchParams(window.location.search).get("redirect") || "airdrop.html";
      const separator = redirectTarget.includes("?") ? "&" : "?";
      window.location.href = `${redirectTarget}${separator}user=${encodeURIComponent(account.wallet)}#dashboard`;
    } catch (error) {
      elements.signupLoading.hidden = true;
      elements.signupForm.hidden = false;
      alert(error.message);
    }
  });
}

if (elements.leaderboardBody) {
  const userFromUrl = new URLSearchParams(window.location.search).get("user");
  const localAccount = participants.find((participant) => participant.wallet === localStorage.getItem(WALLET_KEY));
  const userToSelect = userFromUrl || localAccount?.wallet;
  const signedUpUser = userToSelect ? selectUserByQuery(userToSelect) : null;

  if (signedUpUser) {
    selectedUserId = signedUpUser.id;
    elements.lookupInput.value = signedUpUser.username;
  }

  elements.refreshButton.addEventListener("click", refreshLeaderboard);
  elements.leaderboardSearch.addEventListener("input", renderLeaderboard);
  elements.exportButton.addEventListener("click", exportCsv);

  elements.lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const user = selectUserByQuery(elements.lookupInput.value);

    if (!user) {
      alert("No matching participant found.");
      return;
    }

    selectedUserId = user.id;
    renderDashboard();
  });

  elements.copyReferralButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.referralLink.value);
    } catch (error) {
      elements.referralLink.select();
      document.execCommand("copy");
    }

    elements.copyReferralButton.textContent = "Copied";
    setTimeout(() => {
      elements.copyReferralButton.textContent = "Copy";
    }, 1400);
  });

  elements.profilePhotoInput.addEventListener("change", () => {
    const file = elements.profilePhotoInput.files?.[0];
    const user = getSelectedUser();

    if (!file || !user) {
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      user.profilePhoto = reader.result;
      elements.profilePhotoPreview.src = user.profilePhoto;
      saveLocalParticipants();
      renderParticipantsTable();
    });
    reader.readAsDataURL(file);
  });

  elements.awardForm.addEventListener("submit", (event) => {
    event.preventDefault();
    awardPoints($("#awardUsername").value, $("#awardPoints").value, $("#awardReason").value);
    elements.awardForm.reset();
  });

  elements.memeList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-meme-action]");

    if (!button) {
      return;
    }

    const participant = participants.find((item) => item.id === button.dataset.userId);

    if (!participant?.meme) {
      return;
    }

    participant.meme.status = button.dataset.memeAction;
    saveLocalParticipants();
    renderAll();
  });

  setInterval(() => {
    refreshRemaining -= 1;

    if (refreshRemaining <= 0) {
      refreshLeaderboard();
      return;
    }

    elements.refreshCountdown.textContent = refreshRemaining;
  }, 1000);

  renderAll();
  refreshLeaderboard();
}
