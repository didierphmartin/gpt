# Skills

A skill teaches the assistant a task it can **carry out**: produce a Word document, convert a file, fill a template, analyse a spreadsheet…

## What a skill is

A skill is a **folder** in the `skills/` folder of your local synergyAI folder. It holds a `SKILL.md` file (its name, a description of when to use it, and instructions) and usually Python scripts. The scripts run **in your browser** (Pyodide), against your local folder, so nothing is uploaded to a server to run them. What a skill produces lands in `outputs/`.

## Using a skill

- **Automatically** — just ask: "turn this document into a slide deck". The assistant reads the skills' descriptions and picks the right one.
- **By choice** — drag a skill onto the prompt input: a chip shows it, and the next message uses that skill. Click the chip's × to detach it.
- **In a workflow** — an agent can have a skill, which then runs as a step after the agent answers.

## Adding skills

- **Import** a skill folder, a `.zip` or `.skill` file, or a skill from GitHub.
- **Write one** — create a folder with a `SKILL.md`; the description in its header is what the assistant reads to decide when to use it.

When a skill's script fails, the assistant can propose a fix (self-healing), and the Skills view lets you review and improve skills over time.
