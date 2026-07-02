# So you put an agent in a while loop. So what?

By now you've seen the demo. Someone wraps a coding agent in a shell loop, walks
away, and comes back to a finished feature, or six repositories shipped
overnight, or a production bug that healed itself before anyone filed a ticket.
The Ralph Wiggum loop, named for the cheerfully persistent Simpsons character,
turned this into a recognizable shape: spawn a fresh agent, let it read the plan
from disk, do one task, commit, and exit, then do it again until the list is
empty. It is, in its purest form, a bash `while` loop, and that is exactly why it
caught on.

The pattern is real and it works more often than skeptics expect. But "an agent
in a loop" is a demo, not a workflow. The interesting question for someone
building software on a Tuesday afternoon is narrower: where does this actually
save *me* time, and where does it quietly waste it? That is the "so what" worth
answering before you adopt anything.

## Where a structured loop earns its keep

The honest version of the value proposition is not "the agent does your job." It
is "the agent does the tedious middle of a task you can describe and check." If
you can write down what done looks like as a command that exits zero, a loop can
grind toward it while you do something else.

A few places this pays off for an individual, today:

**The dull conversion work.** Migrations, codemods, adding a missing pattern
(retries, logging, input validation) across dozens of call sites, bringing a
flaky test suite to green. These are tasks where you already know the shape of
the answer and the verification is mechanical. A loop that drives an agent, runs
your tests, feeds the failures back, and tries again is genuinely faster than
doing it by hand, and faster than babysitting a single chat turn.

**Turning your ad-hoc loop into something you can rerun.** Most people's first
loop is a bash script with a hardcoded prompt. It works once. The value of
writing the loop as a declarative spec is that next week's version is lintable,
reproducible, and reviewable. You can diff it, you can hand it to a teammate, and
you can lint it *before* spending tokens to find out you pointed it at the wrong
directory. Catching a misconfigured workspace statically, in milliseconds, beats
discovering it after an hour of agent turns.

**Batching a punch list.** The real unlock for solo work is not one loop, it is
ten small ones queued up against one or more repos. A fix-list of small,
independently verifiable tasks is exactly the workload that runs well unattended:
each item has its own success check, items that touch the same workspace
serialize so they cannot clobber each other, and a failure in one does not sink
the rest.

**Experiments and tuning.** Some tasks are not pass/fail but "get this number
better." Converging on a latency budget, a bundle size, an accuracy threshold.
A loop that reads a metric and compares it against a baseline turns A/B tuning
into something you can leave running and check later.

The common thread: loops accelerate work whose success is *checkable without
you in the room*. That qualifier is doing a lot of work, and it is where the
counter-perspective starts.

## The part the demos skip

A loop is only as good as the feedback it runs on. As one widely shared line
puts it, a loop without high-fidelity feedback is just a very expensive
hallucination. Here is what that means in practice.

**Cost compounds quietly.** Multi-turn loops accumulate context, and tokens
spent scale with iterations. An unbounded loop chasing a goal it cannot reach
will happily spend your budget spinning its wheels. The fix is mundane:
iteration caps, change detection so a turn that edited nothing cannot claim
progress, and a stop condition you trust. None of that is automatic.

**Green is not the same as done.** This is the failure mode that should keep you
honest. Agents optimize for whatever you measure, and if the measurement is
gameable, they will game it, usually without meaning to. Research has documented
agents that rewrote test outcomes to "passed," replaced system utilities with
fakes that report success, or leaned on recall of a known answer rather than
actually solving the task. Most of this is still catchable by a human reading
the transcript. It is just expensive to catch, and a loop runs precisely when
no human is reading.

This is why the maker/checker split matters more than any other piece. An agent
asked to grade its own work tends to praise it. A separate, skeptical checker,
ideally a different model with different instructions, is the only thing that
lets you walk away. And the uncomfortable truth is that the tool cannot write
that checker for you. It can enforce that your checker is meaningful, for
instance by failing a run whose check was already green before the agent
started (a check that passes before any work is not verifying anything), but the
judgment about *what* to verify is yours.

**Full autonomy is still a fool's errand for most work.** The people getting
real value have largely stopped chasing hands-off completion. They run the
firehose in short, controlled bursts and check the results carefully after each
one. Loops are good at the verifiable middle of a task. The framing of the
problem, the choice of what good looks like, the subjective calls about design
and trade-offs: those stay with you. Tasks with unclear or subjective success
criteria are exactly where a loop adds cost without adding quality.

## So, what?

The realistic payoff is not a robot that builds your software. It is a way to
compress the grind around tasks you can already specify and check, and to make
those loops reproducible instead of disposable. That is a meaningful speedup if
your work has a checkable core, and close to useless if it does not.

The practical takeaway for an individual is to be deliberate about the boundary.
Reach for a loop when you can state success as something a machine can verify,
bound the cost, and trust your checker enough to not read every line. Stay in
the loop, in the old-fashioned sense, when the task is fuzzy, the verification is
weak, or the cost of a confident wrong answer is high. The technology that
genuinely accelerates you is not the loop itself. It is the discipline around it:
a real stop condition, an independent verifier, and the humility to know which
tasks belong in the queue and which belong on your own desk.

---

### Further reading

- Geoffrey Huntley, [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/)
- Anthropic, [Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents) (the evaluator-optimizer pattern)
- Addy Osmani, [Loop Engineering](https://addyosmani.com/blog/loop-engineering/) (the maker/checker split)
- ["100% Autonomous 'Agentic' Coding Is a Fool's Errand"](https://codemanship.wordpress.com/2026/02/18/100-autonomous-agentic-coding-is-a-fools-errand/)
- ["The Hidden Cost of Agentic Coding"](https://medium.com/@jonschdev/the-hidden-cost-of-agentic-coding-when-ai-agents-spin-their-wheels-on-your-dime-8e2be518ae3b)
- arXiv, ["The Verification Horizon: No Silver Bullet for Coding Agent Rewards"](https://arxiv.org/html/2606.26300v1)
