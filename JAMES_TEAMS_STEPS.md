# PCT Co-Pilot in Teams: what we need from PCT

James,

We have the Knowledge Co-Pilot ready to answer inside Microsoft Teams, in a
one to one chat, the same engine that already answers on the web. To switch it
on for PCT there are two admin jobs that need your account rather than mine.
They take a few minutes. Each step says where to click and what the screen
should show when it has worked.

Nothing here lets the Co-Pilot message anyone on its own, and nothing sends any
email. It only answers when a person asks it a question.

## Part A: register the bot

I will try this on my own account first and tell you whether it went through.
If my account is not allowed to, these are the steps. If I managed it, skip to
Part B.

1. Go to https://dev.teams.microsoft.com and sign in with your PCT account.
2. In the left menu choose Tools, then Bot management.
3. Choose New bot. Name it `PCT Co-Pilot Bot` and create it. The screen should
   show the new bot with an automatically created app id, a long string of
   letters and numbers.
4. Open the bot, find its Endpoint address or Messaging endpoint, and set it to:
   `[ENGINE URL]/api/teams/messages`
   I will give you the exact `[ENGINE URL]` to paste. It should save without an
   error.
5. In the bot, find Client secrets, add a secret, and copy the value it shows
   once. Send that value to me through our password manager or a call, not by
   email. I will put it into the engine.
6. Copy the bot's app id from the bot page and send that to me as well. The app
   id is not sensitive, so email is fine for that one.

When this part has worked, the bot page shows an app id and a saved endpoint.

## Part B: allow the app for PCT

Once the bot is registered, I will build a small app file and send it to you,
named `pct-copilot-teams.zip`. Then:

1. Go to https://admin.teams.microsoft.com and sign in.
2. In the left menu choose Teams apps, then Manage apps.
3. Near the top choose Upload, then Upload a custom app, and pick the
   `pct-copilot-teams.zip` I sent. It should appear in the list as
   "PCT Co-Pilot".
4. Open "PCT Co-Pilot" in the list. To let everyone use it, set its status to
   Allowed. To start with a few of us instead, leave it as is and add the
   pilot names through a setup policy, and I can talk you through that if you
   prefer a small start.

When this part has worked, "PCT Co-Pilot" shows in Manage apps with the status
you chose.

## Trying it

1. In Teams, choose Apps in the left bar, search for "PCT Co-Pilot", and choose
   Add.
2. In the chat that opens, ask a product question, for example "what is the
   pressure rating of the Marwin CV3000?".

It should reply within a few seconds with an answer and a short Sources line
naming the documents it used. A question the documents do not cover gets an
honest "I do not have that" with no sources, which is the behaviour we want.

Thanks,
John
