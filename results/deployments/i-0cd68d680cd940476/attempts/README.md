# Initial administrative loopback check

The first start loaded the verified images, started all seven containers and successfully obtained public HTTPS. Its final administrative `curl http://127.0.0.1:8080/status` returned connection failure (exit 7). This attempt is retained in `initial-start-loopback-check-failed.log`; it is not labelled a passed run.

Inspection showed the configured gateway host-port binding existed in HostConfig but Docker had not installed an actual published port while every gateway network was internal. Public HTTPS through Caddy's private web connection was already functional.

The correction adds the gateway to the existing non-internal edge bridge, retaining the explicit 127.0.0.1 binding. No private backend/status/controller/gate service gains edge access or a published port. Only the gateway was recreated. Fresh runtime checks confirm loopback publication, unchanged backend identities, healthy telemetry, valid public HTTPS and blocked external private ports.

Logs are sanitized to remove the certificate-contact email and administrator source IP. Original private runtime configuration and SSH/TLS private keys are not part of this evidence.
