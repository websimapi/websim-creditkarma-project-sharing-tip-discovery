import { Fragment, jsxDEV } from "react/jsx-dev-runtime";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { WebsimSocket, useQuery } from "@websim/use-query";
const room = new WebsimSocket();
const COLLECTION_NAME = "project_tip_contributions_v3";
const SCANNED_PROJECTS_COLLECTION = "scanned_projects";
async function getProjectStats(projectId) {
  try {
    const response = await fetch(`/api/v1/projects/${projectId}/stats`);
    if (!response.ok) return null;
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching project stats:", error);
    return null;
  }
}
async function shouldRescanProject(projectId) {
  try {
    const scannedData = await room.collection(SCANNED_PROJECTS_COLLECTION).filter({ project_id: projectId }).getList();
    if (scannedData.length === 0) {
      return true;
    }
    const lastScan = scannedData[0];
    const lastScannedTime = new Date(lastScan.last_scanned_at);
    const hoursSinceLastScan = (Date.now() - lastScannedTime.getTime()) / (1e3 * 60 * 60);
    if (hoursSinceLastScan < 4) {
      const params = new URLSearchParams({ first: "1" });
      const response = await fetch(`/api/v1/projects/${projectId}/comments?${params}`);
      if (!response.ok) return false;
      const data = await response.json();
      const currentCommentCount = data.comments.meta.count || 0;
      return currentCommentCount > lastScan.last_comment_count;
    }
    return true;
  } catch (error) {
    console.error("Error checking if should rescan:", error);
    return true;
  }
}
async function updateScannedProjectRecord(projectId, commentCount) {
  try {
    await room.collection(SCANNED_PROJECTS_COLLECTION).upsert({
      project_id: projectId,
      last_scanned_at: (/* @__PURE__ */ new Date()).toISOString(),
      last_comment_count: commentCount
    });
  } catch (error) {
    console.error("Error updating scanned project record:", error);
  }
}
async function fetchAllTipComments(projectId, onProgress) {
  let allComments = [];
  let hasNextPage = true;
  let afterCursor = null;
  let pageNum = 0;
  let totalCommentCount = 0;
  while (hasNextPage) {
    const params = new URLSearchParams({ only_tips: "true", first: "100" });
    if (afterCursor) {
      params.append("after", afterCursor);
    }
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/comments?${params}`);
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          onProgress(`(Project ${projectId} comments not accessible, skipping)`);
        } else {
          console.error("Failed to fetch comments:", response.statusText);
        }
        break;
      }
      const data = await response.json();
      const { data: comments, meta } = data.comments;
      if (pageNum === 0) {
        totalCommentCount = meta.count || 0;
      }
      if (comments.length > 0) {
        allComments.push(...comments);
      }
      hasNextPage = meta.has_next_page;
      afterCursor = meta.end_cursor;
      pageNum++;
    } catch (error) {
      console.error("Error fetching comments for project " + projectId, error);
      hasNextPage = false;
    }
  }
  return { comments: allComments, totalCommentCount };
}
function processTips(comments) {
  const userTips = /* @__PURE__ */ new Map();
  comments.forEach((item) => {
    const comment = item.comment;
    if (comment && comment.author && comment.card_data && comment.card_data.type === "tip_comment") {
      const { author, card_data } = comment;
      const existingEntry = userTips.get(author.id);
      if (existingEntry) {
        existingEntry.total_tipped += card_data.credits_spent;
      } else {
        userTips.set(author.id, {
          total_tipped: card_data.credits_spent,
          username: author.username,
          tipper_user_id: author.id
        });
      }
    }
  });
  return Array.from(userTips.values());
}
async function syncProjectTips(projectId, onProgress) {
  const shouldScan = await shouldRescanProject(projectId);
  if (!shouldScan) {
    onProgress(`Project ${projectId} was recently scanned with no new activity. Skipping.`);
    return;
  }
  const result = await fetchAllTipComments(projectId, onProgress);
  const { comments: allTipComments, totalCommentCount } = result;
  if (allTipComments.length === 0) {
    await updateScannedProjectRecord(projectId, totalCommentCount);
    return;
  }
  onProgress(`Found ${allTipComments.length} tips in project ${projectId}. Processing...`);
  const userTotalsInProject = processTips(allTipComments);
  if (userTotalsInProject.length > 0) {
    const upsertPromises = userTotalsInProject.map((userTotal) => {
      return room.collection(COLLECTION_NAME).upsert({
        id: `${projectId}-${userTotal.tipper_user_id}`,
        project_id: projectId,
        tipper_user_id: userTotal.tipper_user_id,
        username: userTotal.username,
        total_tipped: userTotal.total_tipped
      });
    });
    await Promise.all(upsertPromises);
  }
  await updateScannedProjectRecord(projectId, totalCommentCount);
  onProgress(`Synced ${userTotalsInProject.length} users from project ${projectId}.`);
}
async function getTopTipProjects(limit = 100) {
  try {
    const existingTipProjects = await room.query(`
      SELECT DISTINCT project_id, SUM(total_tipped) as project_total
      FROM public.project_tip_contributions_v3
      GROUP BY project_id
      ORDER BY SUM(total_tipped) DESC
      LIMIT ${limit}
    `).getList();
    if (existingTipProjects && existingTipProjects.length > 0) {
      return existingTipProjects.map((p) => ({ project: { id: p.project_id } }));
    }
    const params = new URLSearchParams({ first: limit.toString(), posted: "true" });
    const response = await fetch(`/api/v1/projects?${params}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.projects.data || [];
  } catch (error) {
    console.error("Error getting top tip projects:", error);
    return [];
  }
}
async function scanUserTipsAcrossProjects(userId, username, onProgress) {
  onProgress(`Scanning for missing tips by ${username}...`);
  let tipsFound = 0;
  let projectsScanned = 0;
  const existingTipProjects = await room.collection(COLLECTION_NAME).filter({
    tipper_user_id: userId
  }).getList();
  const existingProjectIds = new Set(existingTipProjects.map((tip) => tip.project_id));
  onProgress(`Found ${existingTipProjects.length} projects ${username} has already tipped on in our database.`);
  let likedProjects = [];
  try {
    const response = await fetch(`/api/v1/users/${userId}/likes?first=100`);
    if (response.ok) {
      const data = await response.json();
      likedProjects = data.likes.data || [];
      onProgress(`Found ${likedProjects.length} projects ${username} has liked. Checking these for missing tips...`);
    } else {
      onProgress(`Could not fetch liked projects for ${username}, falling back to popular projects.`);
    }
  } catch (error) {
    console.error("Error fetching user likes:", error);
    onProgress(`Error fetching liked projects for ${username}, falling back to popular projects.`);
  }
  let projectsToScan = [];
  for (const likeItem of likedProjects) {
    if (likeItem.project && likeItem.project.id) {
      projectsToScan.push({
        project: { id: likeItem.project.id },
        source: "liked"
      });
    }
  }
  if (projectsToScan.length < 50) {
    const topProjects = await getTopTipProjects(100);
    for (const item of topProjects) {
      if (item.project && item.project.id) {
        const alreadyAdded = projectsToScan.some((p) => p.project.id === item.project.id);
        if (!alreadyAdded) {
          projectsToScan.push({
            project: { id: item.project.id },
            source: "popular"
          });
        }
      }
    }
  }
  onProgress(`Scanning ${projectsToScan.length} targeted projects for ${username}'s tips...`);
  for (const item of projectsToScan) {
    if (item.project && item.project.id) {
      projectsScanned++;
      const sourceLabel = item.source === "liked" ? "(liked)" : "(popular)";
      onProgress(`Scanning project ${projectsScanned}/${projectsToScan.length}: ${item.project.id} ${sourceLabel}`);
      if (existingProjectIds.has(item.project.id)) {
        continue;
      }
      const result = await fetchAllTipComments(item.project.id, () => {
      });
      const { comments: allTipComments } = result;
      const userTips = allTipComments.filter((item2) => {
        const comment = item2.comment;
        return comment && comment.author && comment.author.id === userId && comment.card_data && comment.card_data.type === "tip_comment";
      });
      if (userTips.length > 0) {
        const totalTipped = userTips.reduce((sum, item2) => {
          return sum + (item2.comment.card_data.credits_spent || 0);
        }, 0);
        await room.collection(COLLECTION_NAME).upsert({
          id: `${item.project.id}-${userId}`,
          project_id: item.project.id,
          tipper_user_id: userId,
          username,
          total_tipped: totalTipped
        });
        tipsFound++;
        const sourceLabel2 = item.source === "liked" ? "liked" : "popular";
        onProgress(`Found ${userTips.length} tips (${totalTipped} credits) from ${username} in ${sourceLabel2} project ${item.project.id}`);
      }
    }
  }
  onProgress(`Scan complete! Found ${tipsFound} new tip records for ${username} across ${projectsScanned} projects.`);
  return tipsFound;
}
function ProjectTipDetails({ userId, username, onClose }) {
  const [isScanning, setIsScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const { data: projectTips, loading } = useQuery(room.query(
    "SELECT ptc.project_id, ptc.total_tipped FROM public.project_tip_contributions_v3 ptc WHERE ptc.tipper_user_id = $1 ORDER BY ptc.total_tipped DESC",
    [userId]
  ), [refreshTrigger]);
  const handleScanForMissingTips = async () => {
    setIsScanning(true);
    setScanMessage("Starting scan for missing tips...");
    try {
      const tipsFound = await scanUserTipsAcrossProjects(userId, username, setScanMessage);
      if (tipsFound > 0) {
        setScanMessage(`Scan complete! Found ${tipsFound} new tip records. Refreshing data...`);
        setTimeout(() => {
          setRefreshTrigger((prev) => prev + 1);
          setScanMessage("");
        }, 2e3);
      } else {
        setScanMessage("Scan complete! No new tip data found.");
        setTimeout(() => setScanMessage(""), 3e3);
      }
    } catch (error) {
      console.error("Error scanning for missing tips:", error);
      setScanMessage("Error occurred during scan.");
      setTimeout(() => setScanMessage(""), 3e3);
    } finally {
      setIsScanning(false);
    }
  };
  if (loading) {
    return /* @__PURE__ */ jsxDEV("div", { className: "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto", children: /* @__PURE__ */ jsxDEV("div", { className: "text-center", children: "Loading project tips..." }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 358,
      columnNumber: 11
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 357,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 356,
      columnNumber: 7
    }, this);
  }
  return /* @__PURE__ */ jsxDEV("div", { className: "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto", children: [
    /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between items-center mb-4", children: [
      /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-amber-300", children: [
        /* @__PURE__ */ jsxDEV("img", { src: `https://images.websim.com/avatar/${username}`, className: "w-8 h-8 rounded-full inline mr-2", alt: username }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 369,
          columnNumber: 13
        }, this),
        username,
        "'s Tipping History"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 368,
        columnNumber: 11
      }, this),
      /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: onClose,
          className: "text-gray-400 hover:text-white text-2xl",
          children: "\xD7"
        },
        void 0,
        false,
        {
          fileName: "<stdin>",
          lineNumber: 372,
          columnNumber: 11
        },
        this
      )
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 367,
      columnNumber: 9
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "mb-4 p-3 bg-gray-700 rounded-lg", children: [
      /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between items-center mb-2", children: [
        /* @__PURE__ */ jsxDEV("span", { className: "text-sm text-gray-300", children: "Missing tips from database?" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 383,
          columnNumber: 13
        }, this),
        /* @__PURE__ */ jsxDEV(
          "button",
          {
            onClick: handleScanForMissingTips,
            disabled: isScanning,
            className: "bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold py-1 px-3 rounded transition-all duration-300 disabled:bg-gray-600 disabled:cursor-not-allowed",
            children: isScanning ? "Scanning..." : "Find Missing Tips"
          },
          void 0,
          false,
          {
            fileName: "<stdin>",
            lineNumber: 384,
            columnNumber: 13
          },
          this
        )
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 382,
        columnNumber: 11
      }, this),
      scanMessage && /* @__PURE__ */ jsxDEV("div", { className: "text-xs text-blue-300 mt-2", children: scanMessage }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 393,
        columnNumber: 13
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 381,
      columnNumber: 9
    }, this),
    !projectTips || projectTips.length === 0 ? /* @__PURE__ */ jsxDEV("div", { className: "text-center text-gray-400", children: "No tipping data found for this user." }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 400,
      columnNumber: 11
    }, this) : /* @__PURE__ */ jsxDEV("div", { className: "space-y-3", children: [
      /* @__PURE__ */ jsxDEV("div", { className: "text-sm text-gray-400 mb-4", children: [
        "Tipped on ",
        projectTips.length,
        " project",
        projectTips.length !== 1 ? "s" : ""
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 403,
        columnNumber: 13
      }, this),
      projectTips.map((tip, index) => /* @__PURE__ */ jsxDEV("div", { className: "p-3 bg-gray-700 rounded-md flex items-center justify-between", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "flex items-center", children: [
          /* @__PURE__ */ jsxDEV("span", { className: "text-amber-400 font-bold mr-3", children: [
            index + 1,
            "."
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 409,
            columnNumber: 19
          }, this),
          /* @__PURE__ */ jsxDEV(
            "a",
            {
              href: `https://websim.com/p/${tip.project_id}`,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "text-blue-400 hover:underline font-mono text-sm",
              children: tip.project_id
            },
            void 0,
            false,
            {
              fileName: "<stdin>",
              lineNumber: 410,
              columnNumber: 19
            },
            this
          )
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 408,
          columnNumber: 17
        }, this),
        /* @__PURE__ */ jsxDEV("span", { className: "font-bold text-green-400", children: [
          tip.total_tipped.toLocaleString(),
          " Credits"
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 419,
          columnNumber: 17
        }, this)
      ] }, tip.project_id, true, {
        fileName: "<stdin>",
        lineNumber: 407,
        columnNumber: 15
      }, this))
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 402,
      columnNumber: 11
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 366,
    columnNumber: 7
  }, this) }, void 0, false, {
    fileName: "<stdin>",
    lineNumber: 365,
    columnNumber: 5
  }, this);
}
function TopStats({ onUserClick }) {
  const topTipperQuery = `
    SELECT
      ptc.tipper_user_id,
      ptc.username,
      SUM(ptc.total_tipped) as grand_total
    FROM public.project_tip_contributions_v3 ptc
    GROUP BY ptc.tipper_user_id, ptc.username
    ORDER BY SUM(ptc.total_tipped) DESC
    LIMIT 1
  `;
  const largestTipQuery = `
    SELECT
      ptc.tipper_user_id,
      ptc.username,
      ptc.project_id,
      ptc.total_tipped as largest_tip
    FROM public.project_tip_contributions_v3 ptc
    ORDER BY ptc.total_tipped DESC
    LIMIT 1
  `;
  const mostFrequentTipperQuery = `
    SELECT
      ptc.tipper_user_id,
      ptc.username,
      COUNT(DISTINCT ptc.project_id) as project_count
    FROM public.project_tip_contributions_v3 ptc
    GROUP BY ptc.tipper_user_id, ptc.username
    ORDER BY COUNT(DISTINCT ptc.project_id) DESC
    LIMIT 1
  `;
  const { data: topTipper } = useQuery(room.query(topTipperQuery));
  const { data: largestTip } = useQuery(room.query(largestTipQuery));
  const { data: mostFrequentTipper } = useQuery(room.query(mostFrequentTipperQuery));
  return /* @__PURE__ */ jsxDEV("div", { className: "bg-gray-800 shadow-lg rounded-lg p-4 sm:p-6 mb-6", children: [
    /* @__PURE__ */ jsxDEV("h2", { className: "text-2xl font-bold mb-4 text-center text-amber-300", children: "\u{1F3C6} Hall of Fame" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 469,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4", children: [
      /* @__PURE__ */ jsxDEV("div", { className: "bg-gradient-to-br from-yellow-600 to-yellow-800 rounded-lg p-4 text-center", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "text-2xl mb-2", children: "\u{1F451}" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 474,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("h3", { className: "font-bold text-lg mb-2 text-yellow-100", children: "Top Tipper" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 475,
          columnNumber: 11
        }, this),
        topTipper && topTipper[0] ? /* @__PURE__ */ jsxDEV("div", { children: [
          /* @__PURE__ */ jsxDEV("div", { className: "flex items-center justify-center mb-2", children: [
            /* @__PURE__ */ jsxDEV("img", { src: `https://images.websim.com/avatar/${topTipper[0].username}`, className: "w-8 h-8 rounded-full mr-2", alt: topTipper[0].username }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 479,
              columnNumber: 17
            }, this),
            /* @__PURE__ */ jsxDEV(
              "button",
              {
                onClick: () => onUserClick({ tipper_user_id: topTipper[0].tipper_user_id, username: topTipper[0].username }),
                className: "font-semibold text-white hover:text-yellow-200 cursor-pointer transition-colors",
                children: topTipper[0].username
              },
              void 0,
              false,
              {
                fileName: "<stdin>",
                lineNumber: 480,
                columnNumber: 17
              },
              this
            )
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 478,
            columnNumber: 15
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-yellow-200", children: topTipper[0].grand_total.toLocaleString() }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 487,
            columnNumber: 15
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-sm text-yellow-100", children: "Credits Total" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 488,
            columnNumber: 15
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 477,
          columnNumber: 13
        }, this) : /* @__PURE__ */ jsxDEV("div", { className: "text-yellow-200", children: "No data yet" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 491,
          columnNumber: 13
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 473,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "bg-gradient-to-br from-green-600 to-green-800 rounded-lg p-4 text-center", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "text-2xl mb-2", children: "\u{1F48E}" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 497,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("h3", { className: "font-bold text-lg mb-2 text-green-100", children: "Largest Tip" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 498,
          columnNumber: 11
        }, this),
        largestTip && largestTip[0] ? /* @__PURE__ */ jsxDEV("div", { children: [
          /* @__PURE__ */ jsxDEV("div", { className: "flex items-center justify-center mb-2", children: [
            /* @__PURE__ */ jsxDEV("img", { src: `https://images.websim.com/avatar/${largestTip[0].username}`, className: "w-8 h-8 rounded-full mr-2", alt: largestTip[0].username }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 502,
              columnNumber: 17
            }, this),
            /* @__PURE__ */ jsxDEV(
              "button",
              {
                onClick: () => onUserClick({ tipper_user_id: largestTip[0].tipper_user_id, username: largestTip[0].username }),
                className: "font-semibold text-white hover:text-green-200 cursor-pointer transition-colors",
                children: largestTip[0].username
              },
              void 0,
              false,
              {
                fileName: "<stdin>",
                lineNumber: 503,
                columnNumber: 17
              },
              this
            )
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 501,
            columnNumber: 15
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-green-200", children: largestTip[0].largest_tip.toLocaleString() }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 510,
            columnNumber: 15
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-sm text-green-100", children: "Credits in one project" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 511,
            columnNumber: 15
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 500,
          columnNumber: 13
        }, this) : /* @__PURE__ */ jsxDEV("div", { className: "text-green-200", children: "No data yet" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 514,
          columnNumber: 13
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 496,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "bg-gradient-to-br from-purple-600 to-purple-800 rounded-lg p-4 text-center", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "text-2xl mb-2", children: "\u{1F3AF}" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 520,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("h3", { className: "font-bold text-lg mb-2 text-purple-100", children: "Most Frequent" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 521,
          columnNumber: 11
        }, this),
        mostFrequentTipper && mostFrequentTipper[0] ? /* @__PURE__ */ jsxDEV("div", { children: [
          /* @__PURE__ */ jsxDEV("div", { className: "flex items-center justify-center mb-2", children: [
            /* @__PURE__ */ jsxDEV("img", { src: `https://images.websim.com/avatar/${mostFrequentTipper[0].username}`, className: "w-8 h-8 rounded-full mr-2", alt: mostFrequentTipper[0].username }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 525,
              columnNumber: 17
            }, this),
            /* @__PURE__ */ jsxDEV(
              "button",
              {
                onClick: () => onUserClick({ tipper_user_id: mostFrequentTipper[0].tipper_user_id, username: mostFrequentTipper[0].username }),
                className: "font-semibold text-white hover:text-purple-200 cursor-pointer transition-colors",
                children: mostFrequentTipper[0].username
              },
              void 0,
              false,
              {
                fileName: "<stdin>",
                lineNumber: 526,
                columnNumber: 17
              },
              this
            )
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 524,
            columnNumber: 15
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-purple-200", children: mostFrequentTipper[0].project_count }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 533,
            columnNumber: 15
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-sm text-purple-100", children: "Projects Tipped" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 534,
            columnNumber: 15
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 523,
          columnNumber: 13
        }, this) : /* @__PURE__ */ jsxDEV("div", { className: "text-purple-200", children: "No data yet" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 537,
          columnNumber: 13
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 519,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 471,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 468,
    columnNumber: 5
  }, this);
}
function Leaderboard({ onUserClick }) {
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [resultsPerPage] = useState(20);
  const [isDeepSearching, setIsDeepSearching] = useState(false);
  const [deepSearchMessage, setDeepSearchMessage] = useState("");
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const offset = (currentPage - 1) * resultsPerPage;
  const leaderboardQuery = `
    SELECT
      ptc.tipper_user_id,
      ptc.username,
      SUM(ptc.total_tipped) as grand_total
    FROM public.project_tip_contributions_v3 ptc
    WHERE ptc.username ILIKE '%${searchTerm}%'
    GROUP BY ptc.tipper_user_id, ptc.username
    ORDER BY SUM(ptc.total_tipped) DESC
    LIMIT ${resultsPerPage}
    OFFSET ${offset}
  `;
  const countQuery = `
    SELECT COUNT(DISTINCT ptc.tipper_user_id) as total_count
    FROM public.project_tip_contributions_v3 ptc
    WHERE ptc.username ILIKE '%${searchTerm}%'
  `;
  const { data: leaderboard, loading } = useQuery(room.query(leaderboardQuery), [refreshTrigger]);
  const { data: countData } = useQuery(room.query(countQuery), [refreshTrigger]);
  const totalCount = countData && countData[0] ? countData[0].total_count : 0;
  const totalPages = Math.ceil(totalCount / resultsPerPage);
  const hasExactMatch = searchTerm && leaderboard && leaderboard.some(
    (entry) => entry.username.toLowerCase() === searchTerm.toLowerCase()
  );
  const handleSearchChange = (e) => {
    setSearchTerm(e.target.value);
    setCurrentPage(1);
  };
  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };
  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };
  const handleUserClick = (user) => {
    onUserClick(user);
  };
  const handleDeepSearch = async (username) => {
    setIsDeepSearching(true);
    setDeepSearchMessage(`Searching for user "${username}"...`);
    try {
      const response = await fetch(`/api/v1/users/${username}`);
      if (!response.ok) {
        setDeepSearchMessage(`User "${username}" not found on WebSim.`);
        setTimeout(() => {
          setDeepSearchMessage("");
          setIsDeepSearching(false);
        }, 3e3);
        return;
      }
      const userData = await response.json();
      const userId = userData.user.id;
      setDeepSearchMessage(`Found user "${username}". Starting deep tip scan...`);
      const tipsFound = await scanUserTipsAcrossProjects(userId, username, setDeepSearchMessage);
      if (tipsFound > 0) {
        setDeepSearchMessage(`Deep search complete! Found ${tipsFound} tip records for ${username}. Refreshing leaderboard...`);
        setTimeout(() => {
          setRefreshTrigger((prev) => prev + 1);
          setDeepSearchMessage("");
          setIsDeepSearching(false);
        }, 2e3);
      } else {
        setDeepSearchMessage(`Deep search complete! No tip data found for ${username}.`);
        setTimeout(() => {
          setDeepSearchMessage("");
          setIsDeepSearching(false);
        }, 3e3);
      }
    } catch (error) {
      console.error("Error during deep search:", error);
      setDeepSearchMessage("Error occurred during deep search.");
      setTimeout(() => {
        setDeepSearchMessage("");
        setIsDeepSearching(false);
      }, 3e3);
    }
  };
  if (loading && !leaderboard) {
    return /* @__PURE__ */ jsxDEV("div", { className: "text-center p-4", children: "Loading Leaderboard..." }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 656,
      columnNumber: 12
    }, this);
  }
  return /* @__PURE__ */ jsxDEV("div", { className: "bg-gray-800 shadow-lg rounded-lg p-4 sm:p-6", children: [
    /* @__PURE__ */ jsxDEV("h2", { className: "text-2xl font-bold mb-4 text-center text-amber-300", children: "Top Tippers" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 661,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "mb-4", children: /* @__PURE__ */ jsxDEV(
      "input",
      {
        type: "text",
        placeholder: "Search for a tipper...",
        value: searchTerm,
        onChange: handleSearchChange,
        className: "w-full px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:outline-none focus:border-amber-500"
      },
      void 0,
      false,
      {
        fileName: "<stdin>",
        lineNumber: 665,
        columnNumber: 9
      },
      this
    ) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 664,
      columnNumber: 7
    }, this),
    deepSearchMessage && /* @__PURE__ */ jsxDEV("div", { className: "mb-4 p-3 bg-gray-700 rounded-lg", children: /* @__PURE__ */ jsxDEV("div", { className: "text-sm text-blue-300", children: deepSearchMessage }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 677,
      columnNumber: 11
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 676,
      columnNumber: 9
    }, this),
    !leaderboard || leaderboard.length === 0 ? /* @__PURE__ */ jsxDEV("div", { className: "text-center p-4", children: searchTerm ? /* @__PURE__ */ jsxDEV("div", { className: "space-y-3", children: [
      /* @__PURE__ */ jsxDEV("p", { children: [
        'No tippers found matching "',
        searchTerm,
        '"'
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 687,
        columnNumber: 15
      }, this),
      /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: () => handleDeepSearch(searchTerm),
          disabled: isDeepSearching,
          className: "inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-all duration-300 disabled:bg-gray-600 disabled:cursor-not-allowed",
          children: [
            /* @__PURE__ */ jsxDEV("span", { className: "text-xl", children: "+" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 693,
              columnNumber: 17
            }, this),
            isDeepSearching ? "Searching..." : `Search for "${searchTerm}" across all projects`
          ]
        },
        void 0,
        true,
        {
          fileName: "<stdin>",
          lineNumber: 688,
          columnNumber: 15
        },
        this
      )
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 686,
      columnNumber: 13
    }, this) : "No tip data found yet. Be the first to contribute!" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 684,
      columnNumber: 9
    }, this) : /* @__PURE__ */ jsxDEV(Fragment, { children: [
      /* @__PURE__ */ jsxDEV("div", { className: "mb-4 text-sm text-gray-400 text-center", children: [
        "Showing ",
        (currentPage - 1) * resultsPerPage + 1,
        "-",
        Math.min(currentPage * resultsPerPage, totalCount),
        " of ",
        totalCount,
        " tippers",
        searchTerm && ` matching "${searchTerm}"`
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 704,
        columnNumber: 11
      }, this),
      /* @__PURE__ */ jsxDEV("ol", { className: "list-decimal list-inside space-y-3", start: (currentPage - 1) * resultsPerPage + 1, children: leaderboard.map((entry, index) => /* @__PURE__ */ jsxDEV("li", { className: "p-3 bg-gray-700 rounded-md flex items-center justify-between", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "flex items-center", children: [
          /* @__PURE__ */ jsxDEV("span", { className: "text-lg font-bold mr-3 text-amber-400", children: [
            (currentPage - 1) * resultsPerPage + index + 1,
            "."
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 713,
            columnNumber: 19
          }, this),
          /* @__PURE__ */ jsxDEV("img", { src: `https://images.websim.com/avatar/${entry.username}`, className: "w-8 h-8 rounded-full mr-3", alt: entry.username }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 714,
            columnNumber: 19
          }, this),
          /* @__PURE__ */ jsxDEV(
            "button",
            {
              onClick: () => handleUserClick(entry),
              className: "font-semibold hover:underline text-left cursor-pointer hover:text-amber-300 transition-colors",
              children: entry.username
            },
            void 0,
            false,
            {
              fileName: "<stdin>",
              lineNumber: 715,
              columnNumber: 19
            },
            this
          )
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 712,
          columnNumber: 17
        }, this),
        /* @__PURE__ */ jsxDEV("span", { className: "font-bold text-lg text-green-400", children: [
          entry.grand_total.toLocaleString(),
          " Credits"
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 722,
          columnNumber: 17
        }, this)
      ] }, entry.tipper_user_id, true, {
        fileName: "<stdin>",
        lineNumber: 711,
        columnNumber: 15
      }, this)) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 709,
        columnNumber: 11
      }, this),
      searchTerm && !hasExactMatch && /* @__PURE__ */ jsxDEV("div", { className: "mt-4 text-center", children: /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: () => handleDeepSearch(searchTerm),
          disabled: isDeepSearching,
          className: "inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-all duration-300 disabled:bg-gray-600 disabled:cursor-not-allowed",
          children: [
            /* @__PURE__ */ jsxDEV("span", { className: "text-xl", children: "+" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 735,
              columnNumber: 17
            }, this),
            isDeepSearching ? "Searching..." : `Deep search for "${searchTerm}"`
          ]
        },
        void 0,
        true,
        {
          fileName: "<stdin>",
          lineNumber: 730,
          columnNumber: 15
        },
        this
      ) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 729,
        columnNumber: 13
      }, this),
      totalPages > 1 && /* @__PURE__ */ jsxDEV("div", { className: "mt-6 flex justify-center items-center gap-4", children: [
        /* @__PURE__ */ jsxDEV(
          "button",
          {
            onClick: handlePreviousPage,
            disabled: currentPage === 1,
            className: "px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed disabled:text-gray-500",
            children: "Previous"
          },
          void 0,
          false,
          {
            fileName: "<stdin>",
            lineNumber: 744,
            columnNumber: 15
          },
          this
        ),
        /* @__PURE__ */ jsxDEV("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsxDEV("span", { className: "text-gray-400", children: "Page" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 753,
            columnNumber: 17
          }, this),
          /* @__PURE__ */ jsxDEV("span", { className: "font-bold text-amber-300", children: currentPage }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 754,
            columnNumber: 17
          }, this),
          /* @__PURE__ */ jsxDEV("span", { className: "text-gray-400", children: "of" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 755,
            columnNumber: 17
          }, this),
          /* @__PURE__ */ jsxDEV("span", { className: "font-bold text-amber-300", children: totalPages }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 756,
            columnNumber: 17
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 752,
          columnNumber: 15
        }, this),
        /* @__PURE__ */ jsxDEV(
          "button",
          {
            onClick: handleNextPage,
            disabled: currentPage === totalPages,
            className: "px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed disabled:text-gray-500",
            children: "Next"
          },
          void 0,
          false,
          {
            fileName: "<stdin>",
            lineNumber: 759,
            columnNumber: 15
          },
          this
        )
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 743,
        columnNumber: 13
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 702,
      columnNumber: 9
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 660,
    columnNumber: 5
  }, this);
}
function App() {
  const [statusMessage, setStatusMessage] = useState("Initializing...");
  const [currentSyncMessage, setCurrentSyncMessage] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [projectInput, setProjectInput] = useState("");
  const [isScanningProject, setIsScanningProject] = useState(false);
  const [isScanningMyself, setIsScanningMyself] = useState(false);
  const [myScanMessage, setMyScanMessage] = useState("");
  useEffect(() => {
    async function init() {
      try {
        const project = await window.websim.getCurrentProject();
        if (!project || !project.id) {
          setStatusMessage("Could not get current project info.");
          return;
        }
        setStatusMessage("Syncing tips for the current project...");
        await syncProjectTips(project.id, setCurrentSyncMessage);
        setStatusMessage("Current project synced. Ready to scan all projects.");
        setTimeout(() => setStatusMessage(""), 5e3);
      } catch (e) {
        console.error(e);
        setStatusMessage("An error occurred during initialization.");
      }
    }
    init();
    const handleNewComment = async (event) => {
      const comment = event.comment;
      if (comment && comment.card_data && comment.card_data.type === "tip_comment") {
        setStatusMessage("New tip detected! Rescanning project to update leaderboard...");
        const project = await window.websim.getCurrentProject();
        if (project && project.id) {
          await syncProjectTips(project.id, setCurrentSyncMessage);
          setStatusMessage("Leaderboard updated with new tip.");
          setTimeout(() => setStatusMessage(""), 5e3);
        }
      }
    };
    window.websim.addEventListener("comment:created", handleNewComment);
    return () => window.websim.removeEventListener("comment:created", handleNewComment);
  }, []);
  const handleUserClick = (user) => {
    setSelectedUser(user);
  };
  const handleCloseDetails = () => {
    setSelectedUser(null);
  };
  const handleStartScan = async () => {
    setIsScanning(true);
    setStatusMessage("Starting global scan...");
    await startGlobalScan(setCurrentSyncMessage);
    setStatusMessage("Global scan finished.");
    setIsScanning(false);
    setTimeout(() => setStatusMessage(""), 5e3);
  };
  const parseProjectIdentifier = (input) => {
    if (!input) return null;
    const cleaned = input.trim();
    const urlMatch = cleaned.match(/websim\.com\/p\/([^/?#]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }
    const slugMatch = cleaned.match(/^\/p\/([^/?#]+)$/);
    if (slugMatch) {
      return slugMatch[1];
    }
    const partialSlugMatch = cleaned.match(/^\/p\/([^/?#]+)/);
    if (partialSlugMatch) {
      return partialSlugMatch[1];
    }
    return cleaned;
  };
  const handleScanProject = async () => {
    const projectId = parseProjectIdentifier(projectInput);
    if (!projectId) {
      setStatusMessage("Please enter a valid project ID, URL, or URL slug.");
      setTimeout(() => setStatusMessage(""), 3e3);
      return;
    }
    setIsScanningProject(true);
    setStatusMessage(`Scanning project ${projectId} for tip data...`);
    try {
      await syncProjectTips(projectId, setCurrentSyncMessage);
      setStatusMessage(`Successfully scanned project ${projectId}.`);
      setProjectInput("");
    } catch (error) {
      console.error("Error scanning project:", error);
      setStatusMessage(`Error scanning project ${projectId}.`);
    } finally {
      setIsScanningProject(false);
      setTimeout(() => setStatusMessage(""), 5e3);
    }
  };
  const handleScanMyself = async () => {
    setIsScanningMyself(true);
    setMyScanMessage("Getting your user information...");
    try {
      const currentUser = await window.websim.getUser();
      if (!currentUser) {
        setMyScanMessage("Unable to get your user information. Please make sure you're logged in.");
        setTimeout(() => {
          setMyScanMessage("");
          setIsScanningMyself(false);
        }, 3e3);
        return;
      }
      setMyScanMessage(`Starting deep tip scan for ${currentUser.username}...`);
      const tipsFound = await scanUserTipsAcrossProjects(currentUser.id, currentUser.username, setMyScanMessage);
      if (tipsFound > 0) {
        setMyScanMessage(`Deep scan complete! Found ${tipsFound} tip records for you. Opening your tip data...`);
        setTimeout(() => {
          setSelectedUser({
            tipper_user_id: currentUser.id,
            username: currentUser.username
          });
          setMyScanMessage("");
          setIsScanningMyself(false);
        }, 2e3);
      } else {
        setMyScanMessage("Deep scan complete! No new tip data found for you.");
        setTimeout(() => {
          setSelectedUser({
            tipper_user_id: currentUser.id,
            username: currentUser.username
          });
          setMyScanMessage("");
          setIsScanningMyself(false);
        }, 2e3);
      }
    } catch (error) {
      console.error("Error during self scan:", error);
      setMyScanMessage("Error occurred during your tip scan.");
      setTimeout(() => {
        setMyScanMessage("");
        setIsScanningMyself(false);
      }, 3e3);
    }
  };
  return /* @__PURE__ */ jsxDEV("div", { className: "container mx-auto p-4 font-sans", children: [
    /* @__PURE__ */ jsxDEV("div", { className: "text-center my-6 relative", children: [
      /* @__PURE__ */ jsxDEV("h1", { className: "text-4xl font-extrabold text-white tracking-tight", children: "The Great Tip Hunt" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 952,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "mt-2 text-lg text-gray-400", children: "Finding the most generous users across Websim, one project at a time." }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 953,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "absolute top-0 right-0", children: /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: handleScanMyself,
          disabled: isScanningMyself,
          className: "bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg transition-all duration-300 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm",
          children: isScanningMyself ? "Scanning..." : "\u{1F50D} Scan My Tips"
        },
        void 0,
        false,
        {
          fileName: "<stdin>",
          lineNumber: 957,
          columnNumber: 11
        },
        this
      ) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 956,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 951,
      columnNumber: 7
    }, this),
    myScanMessage && /* @__PURE__ */ jsxDEV("div", { className: "mb-4 p-3 bg-purple-900 bg-opacity-50 rounded-lg border border-purple-600", children: /* @__PURE__ */ jsxDEV("div", { className: "text-sm text-purple-200 text-center", children: myScanMessage }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 970,
      columnNumber: 11
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 969,
      columnNumber: 9
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "text-center mb-6 space-y-4", children: [
      /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: handleStartScan,
          disabled: isScanning,
          className: "bg-amber-500 hover:bg-amber-600 text-gray-900 font-bold py-2 px-4 rounded-lg transition-all duration-300 disabled:bg-gray-600 disabled:cursor-not-allowed disabled:text-gray-400",
          children: isScanning ? "Scanning All Projects..." : "Start Global Tip Scan"
        },
        void 0,
        false,
        {
          fileName: "<stdin>",
          lineNumber: 977,
          columnNumber: 9
        },
        this
      ),
      /* @__PURE__ */ jsxDEV("div", { className: "bg-gray-800 rounded-lg p-4 max-w-md mx-auto", children: [
        /* @__PURE__ */ jsxDEV("h3", { className: "text-lg font-semibold text-white mb-3", children: "Scan Individual Project" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 987,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "flex flex-col sm:flex-row gap-2", children: [
          /* @__PURE__ */ jsxDEV(
            "input",
            {
              type: "text",
              placeholder: "Project ID, URL, or /p/slug",
              value: projectInput,
              onChange: (e) => setProjectInput(e.target.value),
              className: "flex-1 px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:outline-none focus:border-amber-500 text-sm",
              disabled: isScanningProject
            },
            void 0,
            false,
            {
              fileName: "<stdin>",
              lineNumber: 989,
              columnNumber: 13
            },
            this
          ),
          /* @__PURE__ */ jsxDEV(
            "button",
            {
              onClick: handleScanProject,
              disabled: isScanningProject || !projectInput.trim(),
              className: "bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-all duration-300 disabled:bg-gray-600 disabled:cursor-not-allowed whitespace-nowrap",
              children: isScanningProject ? "Scanning..." : "Scan Project"
            },
            void 0,
            false,
            {
              fileName: "<stdin>",
              lineNumber: 997,
              columnNumber: 13
            },
            this
          )
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 988,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("p", { className: "text-xs text-gray-400 mt-2", children: 'Enter a project ID, full WebSim URL, or URL slug (e.g., "/p/abc123")' }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 1005,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 986,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 976,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(TopStats, { onUserClick: handleUserClick }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 1011,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Leaderboard, { onUserClick: handleUserClick }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 1013,
      columnNumber: 7
    }, this),
    selectedUser && /* @__PURE__ */ jsxDEV(
      ProjectTipDetails,
      {
        userId: selectedUser.tipper_user_id,
        username: selectedUser.username,
        onClose: handleCloseDetails
      },
      void 0,
      false,
      {
        fileName: "<stdin>",
        lineNumber: 1017,
        columnNumber: 9
      },
      this
    )
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 950,
    columnNumber: 5
  }, this);
}
const root = createRoot(document.getElementById("root"));
root.render(/* @__PURE__ */ jsxDEV(App, {}, void 0, false, {
  fileName: "<stdin>",
  lineNumber: 1028,
  columnNumber: 13
}));
