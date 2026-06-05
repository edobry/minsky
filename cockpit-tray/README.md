- **Build failures.** A runtime rebuild failure keeps the daemon serving the prior
  bundle and shows `Build FAILED (...) - serving prior bundle`. A startup failure
  with **no** prior bundle to serve refuses to spawn (`Cockpit: start failed`) and
  shows `Build FAILED (...) - nothing to serve`. Full build output is appended to
  `~/.local/state/minsky/logs/cockpit-build.log`. A failure also fires a macOS
  **notification** (OS toast) with the error summary (mt#2306), in addition to the
  status label and "Last build" line. The toast requires notification permission
  (requested best-effort on first launch); if it's denied, the label + "Last build"
  menu line remain the reliable surface.
