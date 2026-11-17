[简体中文](README.md) · English

# Paiban

A local task board for Codex on Windows. Assign tasks to the appropriate Codex chat, track execution, read replies, and review results from the panel.

[Quick start](#quick-start) · [Updates](#updates) · [License](LICENSE.md#english) · [Support development](#support-development)

## Features

| Feature | What you can do |
| --- | --- |
| Project boards | Organize tasks into To do, Running, In review, and Done. Use groups, labels, and priorities to keep work organized. |
| Task dispatch | Submit tasks to a selected or matched local Codex chat. Set dependencies, execution order, or parallel work scopes. |
| Result review | Read replies and check execution status. Approve the result or submit feedback for another run. |
| Project references and overview | Save notes, links, and attachments by project and view progress across local projects. |

## Quick start

You need Windows, Node.js 22.13 or later, PowerShell 7, and a running Codex desktop app signed in to your account. The source version has no project dependencies to install.

1. Extract or clone the source locally. Open the directory and a chat in the Codex desktop app.
2. Start the panel from the source directory in that chat's execution environment. On first launch, the environment needs the actual `CODEX_THREAD_ID` of the current chat.

   ```powershell
   $env:PORT = '4319'
   npm.cmd start
   ```

3. Keep the service running and open the [local panel](http://127.0.0.1:4319). Select Start setup. Each step links to the relevant controls and includes a prompt you can paste into Codex for help. Connect Codex and set the device and controller project. Then choose a project and add a task. Set up your own private GitHub repository only if you need cross-device sync.
4. Confirm the target chat when starting a task. When Codex finishes the turn, review the result under In review.

## Updates

Paiban is currently available as source code on GitHub. Back up `data/` and review any local changes before updating. Get the latest source from this repository and reload it using Settings → Advanced Settings → Restart Panel. For guidance, open Settings → About & Updates → View update instructions.

The Windows installer and in-app upgrades are pending release.

## Data and compatibility

The service listens on the loopback interface only. The source version stores tasks and attachments in `data/`. Exclude it when sharing source code. Optional cross-device task sync requires a private GitHub repository you configure. The Codex desktop app manages its chats, sign-in, and approvals. Desktop interface changes may require an adapter update.

## License

Noncommercial use is free. You are welcome to modify the project and share original or modified versions for noncommercial purposes. When sharing, credit Paiban, link to the [original project](https://github.com/lei0620/paiban), and preserve the copyright notice and license. Only commercial use requires prior written permission. Contact the developer on WeChat at `Mr_Lei0620`. See the [Noncommercial Use License](LICENSE.md#english).

## Support development

If the panel helps you, consider starring the repository, reporting an issue, or sharing how you use it. You can also support independent development by scanning the Alipay code. Sponsorship is voluntary and separate from commercial licensing.

<details>
<summary>Alipay donation QR code</summary>

<img src="public/support-alipay.jpg" width="240" alt="Alipay donation QR code">

</details>

## Development

Clone the [Paiban source repository](https://github.com/lei0620/paiban) and follow Quick start. Run `npm run verify` to check source and documentation and run the offline tests.

### Source layout

- [server.mjs](server.mjs) and [panel-runner.mjs](panel-runner.mjs) provide the local service, startup, and safe restart.
- [public/](public/) contains the HTML, CSS, and JavaScript interface.
- [plugins/leix-panel-probe/](plugins/leix-panel-probe/) contains the local Codex chat board plugin.
