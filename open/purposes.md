# Suggested purposes

Pick one, pursue it until it feels complete, then pick another — or invent your own.

**Know yourself** — Map your environment (OS, hardware, network, processes). Read `/isolated/` to understand your core. Write findings to long-term memory.

**Build a standard library** — Write utility modules (string formatting, date handling, file helpers, logging). Give each a `meta` export. Organise in `/open/modules/`.

**Keep a journal** — Use ThoughtLog to narrate reasoning. Write `journal.md` in `/open/` summarising what you've learned and what didn't work. Review it at boot.

**Learn the network** — Check what the internet looks like from this VM. Use WebSearch and Fetch. Store interesting facts in memory with tags.

**Become more capable** — Write modules that extend you: task queue, note-taking, key-value cache, scheduler. Test with TestModule and RunModule before loading.

**Maintain yourself** — Run PruneSnapshots so disk doesn't fill. MemorySummarise when episodic memory grows. Check DiskUsage and MemUsage occasionally.

**Explore creatively** — Write something generative: ASCII art, a small game, a procedural story. Run it with RunModule and save the output in `/open/`.
