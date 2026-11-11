# Tracker transport and port review

Reviewed: 2026-11-08. Sources: the supplied local PDFs, their page content, the Concox flow diagram, and the current gateway listeners. Page numbers below mean physical PDF pages; the Markon contents list does not consistently match its later pagination.

## Conclusion

A single configured tracking-server connection/port is supported for the ordinary Concox platform flow. The Markon document is consistent with one ordinary tracking endpoint, but it does not explicitly specify a TCP-port configuration or guarantee a single destination for every message.

It is therefore too broad to say that every packet or function from either physical device must use only one port. Markon explicitly describes government-server emergency traffic and emergency SMS. Concox also describes device SMS behavior around alarms. The supplied PDFs do not mandate our chosen port numbers 5001 or 5002.

## Direct document evidence

| Source | Evidence | What it establishes |
| --- | --- | --- |
| `V5_UPDATED.pdf`, p. 4, Protocol Packet Format and Protocol Number | One common frame envelope contains a message-type byte: login 0x01, position 0x22, heartbeat 0x13/0x23, alarms 0x26/0x19/0x27, and other types. | These hexadecimal values identify message types, not TCP ports. Packet type tells the decoder how to interpret a frame. |
| `V5_UPDATED.pdf`, pp. 5 and 7 | Login follows establishment of a GPRS connection; heartbeat maintains the terminal/server connection. | Login and heartbeat belong to the connected terminal/platform session. These sections do not assign a numeric listening port. |
| `V5_UPDATED.pdf`, p. 35, Data Flow Diagram | After successful connection and login, alarm, location and heartbeat branches all send to the same backend data server. The diagram was visually inspected because the image is absent from plain text extraction. | Strong evidence for one ordinary platform connection carrying these message types. It does not establish that every model-specific ancillary function has no other destination. |
| `V5_UPDATED.pdf`, p. 16, Alarm Packet | The alarm goes to the server; the described flow can include an address response and a device message to a preset SOS number. | A network alarm packet and device SMS behavior are distinct parts of the described functionality. This is not proof that this application implements address lookup or SOS SMS. |
| `Wetrack140_protocol_Standard.pdf`, pp. 4-7 | Generic ASCII device-to-server frames and the LGN login/response are defined. | An ordinary device/server protocol is described; there is no numeric TCP-port setting in these sections. |
| `Wetrack140_protocol_Standard.pdf`, pp. 25-27 | HBT upload and server response are specified. | Heartbeats are part of ordinary server messaging. |
| `Wetrack140_protocol_Standard.pdf`, p. 31 | Live/history and battery-disconnect, low-battery and reconnect examples all use NRM, with distinct packet-type/alert fields. | Ordinary alert data uses the same packet family as ordinary tracking data. This is consistent with one configured tracking endpoint; a one-port requirement is not explicitly stated. |
| `Wetrack140_protocol_Standard.pdf`, pp. 5 and 28-29 | The emergency EPB message is explicitly described for a government monitoring server, with separate framing/checksum details. | Do not assume all emergency traffic is routed to this application's ordinary endpoint. Government endpoint/address/port provisioning is not established by these pages. |
| `Wetrack140_protocol_Standard.pdf`, p. 30 | An emergency message SMS format is separately defined. | SMS is an additional communication channel and does not pass through our TCP listener merely because the tracker supports it. |

## Current implementation versus documented facts

- `services/gateway/cmd/gateway/main.go` creates two TCP listeners: Markon on 5001 and Concox on 5002. Each accepted connection is assigned its protocol family. These numbers are our deployment choices.
- Within an admitted connection, the gateway frames and decodes successive supported packet types; documented acknowledgements are written on that connection. Different normal packet types do not require different listeners in this implementation.
- The gateway supports a subset of the described packet variants. Publishing a port does not establish support for every feature in either PDF.
- Markon EPB is not enabled: its framing/CRC behavior remains a documented gap. Markon unverified-checksum admission also remains disabled by default.
- No new ports, parsers, checksums or acknowledgements were added during this review.

## What still needs hardware/vendor confirmation

Obtain the actual units' model/firmware and server configuration, including any separate government/emergency, backup or auxiliary endpoint if the firmware offers one. Capture a login, ordinary location, heartbeat and each required alarm, identifying the destination IP/port and connection. The existence of a government destination in the document does not itself prove that a particular unit opens a second connection, uses a different numeric port, or sends that packet to our endpoint.

For our ordinary supported tracking channel, keep Markon 5001 and Concox 5002. There is no evidence in these PDFs requiring a separate ordinary alarm listener. Do not extend that conclusion to every emergency, SMS or auxiliary function.

## Decoder follow-up (2026-11-11)

Subtype `0x94/00` is now supported for the exact documented one-byte subtype plus two-byte voltage payload (PDF p.26). It produces a status event with external power voltage divided by100 and no fabricated position/device time. Section10.2 on p.31 explicitly requires no server response. Unknown subtypes/layouts stay diagnostic; there is no speculative acknowledgement.

Heartbeat bit6 is preserved as a reported tracking flag, not proof that a persistent configuration setting must be enabled. Other documented heartbeat flags and the two raw language/extended-status bytes are retained. EG02/EG03 external voltage is labeled as external power voltage. Mileage remains a raw optional counter because its unit is not established here.

The session malformed-input limit now counts consecutive malformed/CRC-invalid inputs rather than valid unsupported messages. Capture evidence showed peer-originated resets after the first information packet; this correction is not claimed to explain those specific resets. Packet diagnostics and session close reasons expose the distinction without recording raw payloads or SIM identifiers.
