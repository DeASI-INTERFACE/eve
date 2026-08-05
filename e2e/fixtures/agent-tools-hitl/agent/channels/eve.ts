import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: () => ({
    attributes: { fixture: "authorized-response" },
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId: "e2e-approval-responder",
    principalType: "user",
    subject: "e2e-approval-responder",
  }),
});
