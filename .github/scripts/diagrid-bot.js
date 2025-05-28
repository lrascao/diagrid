const fs = require("fs");

const anyOwner = "*";

function getCodeOwners() {
  let o = "";
  try {
    o = fs.readFileSync("CODEOWNERS", "utf8");
  } catch (err) {
    // TODO: change this to not allow when better grouping [June/14/2024]
    console.log("[getCodeOwners] error reading CODEOWNERS file, will allow anybody.");
    o = anyOwner;
  }
  return o
}

const owners = getCodeOwners();

const docsIssueBodyTpl = (
  issueNumber
) => `This issue was automatically created by \
[Diagrid Bot](https://github.com/diagridio/cloudgrid/blob/master/.github/workflows/diagrid-bot.yml) because a \"docs-needed\" label \
was added to diagridio/cloudgrid#${issueNumber}.`;

module.exports = async ({ github, context }) => {
  if (
    context.eventName == "issue_comment" &&
    context.payload.action == "created"
  ) {
    await handleIssueCommentCreate({ github, context });
  } else if (
    context.eventName == "issues" &&
    context.payload.action == "labeled"
  ) {
    await handleIssueLabeled({ github, context });
  } else if (
    context.eventName == "check_suite"
  ) {
      console.log('check_suite triggered');
  } else {
    console.log(`[main] event ${context.eventName} not supported, exiting.`);
  }
};

/**
 * Handle issue comment create event.
 */
async function handleIssueCommentCreate({ github, context }) {
  const payload = context.payload;
  const issue = context.issue;
  const username = context.actor.toLowerCase();
  const isFromPulls = !!payload.issue.pull_request;
  const commentBody = ((payload.comment.body || "") + "").trim();

  if (!commentBody || !commentBody.startsWith("/")) {
    // Not a command
    return;
  }

  const commandParts = commentBody.split(/\s+/);
  const command = commandParts.shift();

  // Commands that can be executed by anyone.
  switch (command) {
    case "/assign":
      await cmdAssign(github, issue, username, isFromPulls);
      return;
    case "/ok-to-merge":
      await cmdOkToMerge(github, issue, username, isFromPulls);
      return;
    case "/help":
      await cmdHelp(github, issue);
  }

  if (!(await isOwner(github, username))) {
    console.log(
      `[handleIssueCommentCreate] user ${username} is not an owner, exiting.`
    );

    await commentUserNotAllowed(github, issue, username);
    return;
  }

  // Commands that can only be executed by owners.
  switch (command) {
    case "/make-me-laugh":
      await cmdMakeMeLaugh(github, issue);
      return;
    case "/ok-to-test":
      await cmdOkToTest(github, issue, payload.comment, isFromPulls, commandParts);
      return;
    case "/ok-to-test-dev":
      await cmdOkToTestDev(github, issue, isFromPulls, commandParts);
      return;
    case "/exec":
      await cmdExec(commandParts);
      return;
    default:
      console.log(
        `[handleIssueCommentCreate] command ${command} not found, exiting.`
      );
      return;
  }
}

/**
 * Handle issue labeled event.
 */
async function handleIssueLabeled({ github, context }) {
  const payload = context.payload;
  const label = payload.label.name;
  const issueNumber = payload.issue.number;

  // This should not run in forks.
  if (context.repo.owner !== "diagridio") {
    console.log("[handleIssueLabeled] not running in diagridio repo, exiting.");
    return;
  }

  // Authorization is not required here because it's triggered by an issue label event.
  // Only authorized users can add labels to issues.
  if (label == "docs-needed") {
    // Open a new issue
    await github.rest.issues.create({
      owner: "diagridio",
      repo: "docs",
      title: `New content needed for diagridio/cloudgrid#${issueNumber}`,
      labels: ["content/missing-information", "created-by/diagrid-bot"],
      body: docsIssueBodyTpl(issueNumber),
    });
  } else {
    console.log(`[handleIssueLabeled] label ${label} not supported, exiting.`);
  }
}

/**
 * Display help message.
 */
async function cmdHelp(github, issue) {
  await github.rest.issues.createComment({
    owner: issue.owner,
    repo: issue.repo,
    issue_number: issue.number,
    body: `👋 Hi, here are the available commands:
      - \`/assign\` - assign the issue to the user who commented
      - \`/make-me-laugh\` - comment a funny joke
      - \`/ok-to-merge\` - check if the pull request is ready to merge
      - \`/ok-to-test\` - trigger e2e test for the pull request
      - \`/exec\` - execute any command
      - \`/help\` - display this help message
      `,
  });
}

/**
 * Assign the issue to the user who commented.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 * @param {string} username GitHub user who commented
 * @param {boolean} isFromPulls is the workflow triggered by a pull request?
 */
async function cmdAssign(github, issue, username, isFromPulls) {
  if (isFromPulls) {
    console.log(
      "[cmdAssign] pull requests unsupported, skipping command execution."
    );
    return;
  } else if (issue.assignees && issue.assignees.length !== 0) {
    console.log(
      "[cmdAssign] issue already has assignees, skipping command execution."
    );
    return;
  }

  await github.rest.issues.addAssignees({
    owner: issue.owner,
    repo: issue.repo,
    issue_number: issue.number,
    assignees: [username],
  });
}

/**
 * Comment a funny joke.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 */
async function cmdMakeMeLaugh(github, issue) {
  const result = await github.request(
    "https://official-joke-api.appspot.com/random_joke"
  );
  jokedata = result.data;
  joke = "I have a bad feeling about this.";
  if (jokedata && jokedata.setup && jokedata.punchline) {
    joke = `${jokedata.setup} - ${jokedata.punchline}`;
  }

  await github.rest.issues.createComment({
    owner: issue.owner,
    repo: issue.repo,
    issue_number: issue.number,
    body: joke,
  });
}

/**
 * Trigger e2e test for the pull request.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 * @param {boolean} isFromPulls is the workflow triggered by a pull request?
 * @param {string[]} args command arguments
 */
async function cmdOkToTest(github, issue, comment, isFromPulls, args) {
  if (!isFromPulls) {
    console.log(
      "[cmdOkToTest] only pull requests supported, skipping command execution."
    );
    return;
  }

  let admingrid_chart_version = "";
  let admingrid_image_tag = "";
  let cloudruntime_chart_version = "";
  let focus = "";
  let skip = "";
  let ssh = "false";

  let parsedArgs = parseArgs(args);

  if (parsedArgs["help"] === "") {
    // create comment with help message
    await github.rest.issues.createComment({
      owner: issue.owner,
      repo: issue.repo,
      issue_number: issue.number,
      body: `👋 Hi, here are the available options for the /ok-to-test command
      - \`--admingrid-chart-version=<version>\` - specify the admingrid chart version to use
      - \`--admingrid-image-tag=<tag>\` - specify the Admingrid image tag to use
      - \`--focus=<focus>\` - specify the focus for the e2e test (eg. TestSuites/TestCatalystE2E)
      - \`--skip=<skip>\` - specify the skip for the e2e test
      - \`--ssh=<ssh-enabled>\` - specify if ssh is enabled for the e2e test (true/false)
      `,
      });
      return;
  }

  if (parsedArgs["admingrid-chart-version"]) {
    admingrid_chart_version = parsedArgs["admingrid-chart-version"];
  }

  if (parsedArgs["admingrid-image-tag"]) {
    admingrid_image_tag = parsedArgs["admingrid-image-tag"];
  }

  if (parsedArgs["focus"]) {
    focus = parsedArgs["focus"];
  }

  if (parsedArgs["skip"]) {
    skip = parsedArgs["skip"];
  }

  if (parsedArgs["ssh"]) {
    ssh = parsedArgs["ssh"].toLowerCase() === "true" ? "true" : "false";
  }

  // Get pull request
  const pull = await github.rest.pulls.get({
    owner: issue.owner,
    repo: issue.repo,
    pull_number: issue.number,
  });

  if (pull && pull.data) {
    // Get commit id and repo from pull head
    const testPayload = {
      pull_head_ref: pull.data.head.sha,
      pull_head_repo: pull.data.head.repo.full_name,
      command: "ok-to-test",
      issue: issue,
      // optional arguments
      admingrid_chart_version: admingrid_chart_version,
      admingrid_image_tag: admingrid_image_tag,
      focus: focus,
      skip: skip,
      ssh: ssh,
    };

    // Fire repository_dispatch event to trigger e2e test
    await github.rest.repos.createDispatchEvent({
      owner: issue.owner,
      repo: issue.repo,
      event_type: "ci-e2e-test",
      client_payload: testPayload,
    });

    // react to the comment with a :+1:
    await github.rest.reactions.createForIssueComment({
      owner: issue.owner,
      repo: issue.repo,
      comment_id: comment.id,
      content: "+1",
    });

    console.log(
      `[cmdOkToTest] triggered E2E test for ${JSON.stringify(testPayload)}`
    );
  }
}

/**
 * Execute any command
 */
async function cmdExec(args) {
  let { cmd, params } = parseCommandAndParams(args);

  if (!cmd && !params) {
    cmd = "echo";
    params = "Hello, World!";
  }

  console.log(`[cmdExec] executing command: ${cmd} ${params}`);

  try {
    const { stdout, stderr } = await execCommandAndParams(cmd, params);
    console.log(`[cmdExec] stdout: ${stdout}`);
    console.error(`[cmdExec] stderr: ${stderr}`);
  } catch (error) {
    console.error(`[cmdExec] error: ${error}`);
  }
}

function execCommandAndParams(cmd, params) {
  return new Promise((resolve, reject) => {
    const { exec } = require("child_process");
    exec(`${cmd} ${params}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`[cmdExec] error: ${error.message}`);
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseCommandAndParams(args) {
  let cmd = "";
  let params = "";

  let parsedArgs = parseArgs(args);

  if (parsedArgs["cmd"]) {
    cmd = parsedArgs["cmd"];
    params = args.slice(args.indexOf('--cmd') + 2).join(' ');
  }
  return { cmd, params };
}

/**
 * Trigger e2e test dev for the pull request.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 * @param {boolean} isFromPulls is the workflow triggered by a pull request?
 * @param {string[]} args command arguments
 */
async function cmdOkToTestDev(github, issue, isFromPulls, args) {
  if (!isFromPulls) {
    console.log(
      "[cmdOkToTestDev] only pull requests supported, skipping command execution."
    );
    return;
  }

  // Get pull request
  const pull = await github.rest.pulls.get({
    owner: issue.owner,
    repo: issue.repo,
    pull_number: issue.number,
  });

  if (pull && pull.data) {
    // Get commit id and repo from pull head
    const testPayload = {
      pull_head_ref: pull.data.head.sha,
      pull_head_repo: pull.data.head.repo.full_name,
      command: "ok-to-test-dev",
      issue: issue,
    };

    // Fire repository_dispatch event to trigger e2e test
    await github.rest.repos.createDispatchEvent({
      owner: issue.owner,
      repo: issue.repo,
      event_type: "ci-e2e-test-dev",
      client_payload: testPayload,
    });

    console.log(
      `[cmdOkToTestDev] triggered E2E test in Dev for ${JSON.stringify(testPayload)}`
    );
  }
}


/**
 * Check if the pull request is ready to merge.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 * @param {string} username GitHub user who commented
 * @param {boolean} isFromPulls is the workflow triggered by a pull request?
 */
async function cmdOkToMerge(github, issue, username, isFromPulls) {
  if (!isFromPulls) {
    console.log(
      "[cmdOkToMerge] only pull requests supported, skipping command execution."
    );
    return;
  }

  // Get pull request
  const pull = await github.rest.pulls.get({
    owner: issue.owner,
    repo: issue.repo,
    pull_number: issue.number,
  });

  if (pull && pull.data) {
    // is pull request approved by a CODEOWNER?
    const reviews = await github.rest.pulls.listReviews({
      owner: issue.owner,
      repo: issue.repo,
      pull_number: issue.number,
    });

    // check approved by an approver
    const approved = reviews.data.some(
      (review) =>
        review.state == "APPROVED" &&
        isOwner(github, review.user.login) &&
        review.user.login != username
    );

    // check no outstanding reviews
    const outstanding = reviews.data.some(
      (review) => review.state == "PENDING"
    );

    if (!approved || outstanding) {
      console.log(
        `[cmdOkToMerge] pull request ${issue.owner}/${issue.repo}#${issue.number} is not ready to merge.`
      );

      await commentNotReadyToMerge(
        github,
        issue,
        username,
        "does not have sufficient approval 👀"
      );

      return;
    }

    // are all checks success?
    const checks = await github.rest.checks.listForRef({
      owner: issue.owner,
      repo: issue.repo,
      ref: pull.data.head.sha,
    });

    const checksSuccess = checks.data.check_runs.every(
      (check) => check.conclusion == "success" || check.conclusion == "skipped"
    );

    if (checksSuccess) {
      await github.rest.issues.addLabels({
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
        labels: ["automerge"],
      });

      console.log(
        `[cmdOkToMerge] pull request ${issue.owner}/${issue.repo}#${issue.number} is ready to merge.`
      );
    } else {
      console.log(
        `[cmdOkToMerge] pull request ${issue.owner}/${issue.repo}#${issue.number} is not ready to merge.`
      );

      await commentNotReadyToMerge(
        github,
        issue,
        username,
        "not all checks are successful ❌"
      );
    }
  }
}

/**
 * Sends a comment when the user who tried triggering the bot action is not allowed to do so.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 * @param {string} username GitHub user who commented
 */
async function commentUserNotAllowed(github, issue, username) {
  await github.rest.issues.createComment({
    owner: issue.owner,
    repo: issue.repo,
    issue_number: issue.number,
    body: `👋 @${username}, my apologies but I can't perform this action for you because your user is not listed in or part of any groups in the CODEOWNERS file.`,
  });
}

/**
 * Sends a comment when the pull request is not ready to merge.
 * @param {*} github GitHub object reference
 * @param {*} issue GitHub issue object
 * @param {string} username GitHub user who commented
 * @param {string} reason reason why the pull request is not ready to merge
 */
async function commentNotReadyToMerge(github, issue, username, reason) {
  await github.rest.issues.createComment({
    owner: issue.owner,
    repo: issue.repo,
    issue_number: issue.number,
    body: `👋 @${username}, my apologies but this pull request is not ready to merge, ${reason}.`,
  });
}

/**
 * Is owner checks whether the user is in the CODEOWNERS file or part of any group in the CODEOWNERS file.
 * @param {*} github GitHub object reference
 * @param {string} username GitHub user who commented
 * @returns {boolean} true if the user is an owner, false otherwise.
 */
async function isOwner(github, username) {
    if (owners === anyOwner) {
        return true; // allow anybody
    }
  if (!owners.includes(username)) {
    const groups = owners
      .substring(owners.indexOf("@"))
      .split("@diagridio/")
      .filter((group) => group.trim())
      .map((group) => group.trim());

    const groupsUsers = await Promise.all(
      groups.map((group) => {
        return github.rest.teams.listMembersInOrg({
          org: "diagridio",
          team_slug: group,
        });
      })
    );

    const ownerUsers = groupsUsers.map((groupUsers) =>
      groupUsers.data.map((user) => user.login)
    );

    if (
      !ownerUsers.some((groupUsers) =>
        groupUsers
          .map((user) => user.toLowerCase())
          .includes(username.toLocaleLowerCase()))) {
      return false; // user is not in CODEOWNERS or in a group
    }
  }
  return true; // user is in CODEOWNERS or in a group
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
      let arg = args[i];
      if (arg.startsWith('--')) {
          arg = arg.slice(2);
          if (arg.includes('=')) {
              const [key, value] = arg.split('=');
              result[key] = value;
          } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
              const key = arg;
              const value = args[++i];
              result[key] = value;
          } else {
              const key = arg;
              result[key] = '';
          }
      }
  }
  return result;
}

module.exports.parseArgs = parseArgs;
module.exports.parseCommandAndParams = parseCommandAndParams;
module.exports.execCommandAndParams = execCommandAndParams;