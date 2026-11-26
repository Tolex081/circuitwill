# CircuitWill beginner test

**Goal:** find out where a first-time, non-technical person gets stuck. We are testing the **product**, not the person.

You need **2 or 3 testers** who have never seen CircuitWill. It works even better if they have never used a crypto wallet. Each session takes **30–40 minutes**, on your computer, with **test money only**.

Part 1 is for you, the host. Part 2 is what you read out to the tester. Part 3 is where you write down what happened.

---

## Part 1 — For you, the host

### Before each tester (5 minutes)

1. Start the test network and the website. Use the three windows from `docs/TESTING_GUIDE.md` Part 5, or ask Claude to start them for you.
   - Serve the up-to-date code from `main`. This folder's current branch, `feat/key-nft-art`, has no rule builder.
2. Open `http://127.0.0.1:5173/frontend/` in the browser.
3. Press **Use the test owner account**, so the tester starts already "connected".
   - On the real site they would connect a wallet like OKX Wallet. Skipping that step today is fine.
4. Open **Notepad** next to the browser and paste these two test addresses, so the tester can copy them:

   ```
   Tunde (a friend):     0x3f40357c6844Fb11A3Eac410f90287beA40aE028
   A stranger:           0x362d70f432F3604Ca6c6e0a3131892F675cC8308
   ```

5. Have a phone or a second window ready to take notes in Part 3.

### Five rules while you watch

1. **Don't help.** If they ask "what do I click?", answer: *"What would you try?"* Help only if they are stuck for **2 minutes**, and write down that you helped.
2. **Ask them to think out loud.** For example: "I'm looking for… I expected… I don't understand…"
3. **Don't explain the product first.** The welcome page has to do that job.
4. **Don't defend the design.** If they say something is confusing, just write it down.
5. **Note the exact words** they use when confused. Those words are the fix.

---

## Part 2 — Read this to the tester

> "Thank you for helping. This is a new app for keeping money safe with rules. We're testing the app, not you. If
> something is confusing, that's the app's fault, and it's exactly what we want to find. Please say your thoughts out
> loud as you go. The money here is fake, so you can't lose anything."

Then give them **one task at a time**. Read each task aloud or show it on a card. **Don't** tell them where to click.

### Task 1 — First look (1 minute)
> "Look at this page for 30 seconds without clicking. Then tell me: what do you think this app does, and who is it
> for?"

### Task 2 — Set it up
> "You want to keep 100 dollars safe. Make sure **no more than 50 can leave in one day**, and that **anything above 20
> needs your OK first**. Set that up."

### Task 3 — Put money in
> "Put **100** into it."

### Task 4 — Pay a friend
> "Send **10** to your friend Tunde. His address is in Notepad."

### Task 5 — A bigger payment
> "Now send Tunde **30**. Tell me what happens, and then make the payment go through."

*(Expected: it's blocked because it's above 20. They have to approve it, then send it again.)*

### Task 6 — A stranger
> "Someone you don't know asks you for **3**. Their address is in Notepad as 'A stranger'. Try to pay them. What
> happened, and why?"

### Task 7 — Your own rule
> "You want to give your son an allowance. He should be able to spend **up to 10 a day, only on weekdays, never after
> 9 pm**. Create that rule. You don't have to finish publishing it."

*(It's on the Rules tab, under "Write a custom rule". The **"Fill in the form from this"** button works with no AI.
"Draft with Claude" needs an API key, so skip it.)*

### Task 8 — Emergency
> "Imagine your phone was just stolen. Stop **all** money from leaving, right now. Then, once you're safe again, undo
> it."

### Task 9 — Look back
> "Find the payment that was blocked earlier and tell me why it was blocked. Then press anything that lets you look
> inside how it decided, and tell me what you think you're seeing."

### Last questions (3 minutes)
1. "In one sentence, what does this app do?"
2. "What was the most confusing moment?"
3. "Who can change your rules?"
4. "Would you trust it with real money? Why or why not?"
5. "On a scale of 1–5, how easy was it?"

---

## Part 3 — Results sheet (one per tester)

**Tester:** ______  **Uses crypto?** never / a little / often  **Date:** ______

| Task | Done alone? (✓ / helped / failed) | Time | Where they hesitated, and their exact words |
|---|---|---|---|
| 1 First look | | | What they think it does: |
| 2 Set it up | | | |
| 3 Put money in | | | |
| 4 Pay a friend | | | |
| 5 Bigger payment | | | Did they understand why it was blocked? Did they find **Approve**? |
| 6 Stranger | | | Did they understand "trusted" and the waiting time? |
| 7 Own rule | | | Did the read-back match what they meant? Did they understand "who it limits"? |
| 8 Emergency | | | Did they find Freeze quickly? And Unfreeze? |
| 9 Look back | | | What did they think the circuit picture shows? |

**Answers to the last questions:**
1.
2.
3.
4.
5. Ease (1–5):

**Words or labels they didn't understand:**

-

---

## After all testers

Look for **problems that 2 or more testers hit**; those are the real ones. Then, in a new session, say:

> *"Read docs/BEGINNER_TEST.md results and fix the problems testers hit most."*

Things worth watching closely, because we're least sure about them:

- **Task 1:** Do they get the idea from the welcome page alone?
- **Task 5:** Is "needs your approval" clear, and do they find the Approve button inside the preview?
- **Task 7:** The builder asks *who* the rule limits ("My AI helper", "Me", "My beneficiary"). Does "son" make sense as "AI helper"? Testers may expect a "family member" option.
- **Task 9:** Does the Circuit X-ray feel impressive, or just confusing?
