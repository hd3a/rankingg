// bot.js
const fs = require("fs");

const studioId = "51396308";

const LIMIT = 40;
const DAY = 24 * 60 * 60 * 1000;

const PAGE_WAIT = 120;
const REPLY_PARALLEL = 6;

const RETRY_WAIT = 1000;
const MAX_429 = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let err429 = 0;

async function safeFetch(url) {
  try {
    const r = await fetch(url);

    if (r.status === 429) {
      err429++;

      if (err429 >= MAX_429) {
        throw new Error("429連続");
      }

      await sleep(RETRY_WAIT);
      return safeFetch(url);
    }

    err429 = 0;

    if (!r.ok) return null;

    return r.json();
  } catch {
    return null;
  }
}

// 並列上限付き map
async function parallelMap(arr, limit, fn) {
  let i = 0;

  await Promise.all(
    Array(limit).fill(0).map(async () => {
      while (i < arr.length) {
        await fn(arr[i++]);
      }
    })
  );
}

// 平均
function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// 標準偏差
function stddev(arr, avg) {
  if (arr.length === 0) return 0;

  const variance =
    arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / arr.length;

  return Math.sqrt(variance);
}

// 偏差値
function hensachi(value, avg, sd) {
  if (sd === 0) return 50;
  return 50 + ((value - avg) / sd) * 10;
}

(async () => {
  const commentUsers = new Map();
  const replyUsers = new Map();
  const receivedReplies = new Map();

  let totalComments = 0;
  let totalReplies = 0;

  let offset = 0;
  let stop = false;

  const now = Date.now();

  while (!stop) {
    const comments = await safeFetch(
      `https://api.scratch.mit.edu/studios/${studioId}/comments?offset=${offset}&limit=${LIMIT}`
    );

    if (!comments || comments.length === 0) break;

    const replyTargets = [];

    for (const c of comments) {
      // 24時間超えたら終了
      if (now - new Date(c.datetime_created).getTime() > DAY) {
        stop = true;
        break;
      }

      totalComments++;

      const username = c.author.username;

      // コメント数
      commentUsers.set(
        username,
        (commentUsers.get(username) || 0) + 1
      );

      // 返信された数
      receivedReplies.set(
        username,
        (receivedReplies.get(username) || 0) + c.reply_count
      );

      // 返信があるコメントだけ取得対象
      if (c.reply_count > 0) {
        replyTargets.push(c.id);
      }
    }

    // 返信取得
    await parallelMap(replyTargets, REPLY_PARALLEL, async (id) => {
      const replies = await safeFetch(
        `https://api.scratch.mit.edu/studios/${studioId}/comments/${id}/replies?offset=0&limit=40`
      );

      if (!replies) return;

      for (const r of replies) {
        totalReplies++;

        const username = r.author.username;

        replyUsers.set(
          username,
          (replyUsers.get(username) || 0) + 1
        );
      }
    });

    offset += LIMIT;

    await sleep(PAGE_WAIT);
  }

  // 全ユーザー
  const users = new Set([
    ...commentUsers.keys(),
    ...replyUsers.keys(),
    ...receivedReplies.keys()
  ]);

  // コメント+返信 合計配列
  const totals = [...users].map(name => {
    const c = commentUsers.get(name) || 0;
    const r = replyUsers.get(name) || 0;
    return c + r;
  });

  // 統計
  const avg = average(totals);
  const sd = stddev(totals, avg);

  // ランキング生成
  const ranking = [...users]
    .map(name => {
      const comments = commentUsers.get(name) || 0;
      const replies = replyUsers.get(name) || 0;
      const received = receivedReplies.get(name) || 0;

      const total = comments + replies;

      return {
        name,
        comments,
        replies,
        received,
        total,
        hensachi: hensachi(total, avg, sd)
      };
    })
    .sort((a, b) => b.total - a.total);

  // Markdown生成
  let md = `# 📊 スタジオ活動ランキング\n\n`;

  md += `対象: 過去24時間\n\n`;

  md += `## 全体統計\n\n`;
  md += `- コメント総数: ${totalComments}\n`;
  md += `- 返信総数: ${totalReplies}\n`;
  md += `- 参加人数: ${users.size}\n`;
  md += `- 平均活動数: ${avg.toFixed(2)}\n`;
  md += `- 標準偏差: ${sd.toFixed(2)}\n\n`;

  md += `更新: {{ 'now' | date: "%Y-%m-%d %H:%M:%S" }}\n\n`;

  md += `---\n\n`;

  ranking.forEach((u, i) => {
    md += `## ${i + 1}位 ${u.name}\n\n`;

    md += `- 合計活動数: ${u.total}\n`;
    md += `- コメント数: ${u.comments}\n`;
    md += `- 返信数: ${u.replies}\n`;
    md += `- 返信された数: ${u.received}\n`;
    md += `- 偏差値: ${u.hensachi.toFixed(1)}\n\n`;
  });

  fs.writeFileSync("README.md", md);

  // username.txt
  const namesOnly = ranking.map(u => u.name).join("\n");

  fs.writeFileSync("username.txt", namesOnly);

  console.log("README.md / username.txt 更新完了");
})();
