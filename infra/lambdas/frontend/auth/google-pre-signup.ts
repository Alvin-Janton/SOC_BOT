import { AdminGetUserCommand, CognitoIdentityProviderClient, UserNotFoundException, UserStatusType } from '@aws-sdk/client-cognito-identity-provider';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { z } from 'zod';
import { googleEmail, googleProfileAttribute, googleProfileIdentity } from './google-provider';
import { authSubSchema } from './user-state';

const eventSchema = z.object({ version: z.literal('1'), region: z.literal('us-east-1'), userPoolId: z.string().regex(/^us-east-1_[A-Za-z0-9]+$/),
  userName: z.string().min(1).max(128), triggerSource: z.enum(['PreSignUp_ExternalProvider', 'PreSignUp_SignUp', 'PreSignUp_AdminCreateUser']),
  callerContext: z.object({ awsSdkVersion: z.string(), clientId: z.string().min(1) }),
  request: z.object({ userAttributes: z.record(z.string(), z.string()) }), response: z.object({}) });
const DENIAL = 'Google sign-in could not be completed. Try your existing sign-in method or account recovery.';

/** Rejects first-time unlinked Google/email collisions; native signup remains Cognito-controlled. */
export async function handler(raw: unknown, context: { invokedFunctionArn: string; getRemainingTimeInMillis(): number }): Promise<unknown> {

  try {
    const event = eventSchema.parse(raw);
    const account = process.env.EXPECTED_ACCOUNT_ID;

    if (!account || !/^[0-9]{12}$/.test(account) || process.env.AWS_REGION !== event.region
      || !new RegExp(`^arn:aws:lambda:us-east-1:${account}:function:SOC-BOT-DEV-GOOGLE-PRE-SIGNUP(?::[^:]+)?$`).test(context.invokedFunctionArn)) throw new Error(DENIAL);

    // The exact-pool SourceArn invocation permission and AdminGetUser policy bind this event to its pool.
    if (event.triggerSource !== 'PreSignUp_ExternalProvider') return raw;
    const provider = /^google_([^\s]+)$/i.exec(event.userName);
    if (!provider || event.request.userAttributes.email_verified !== 'true') throw new Error(DENIAL);
    const email = googleEmail(event.request.userAttributes.email);
    const timeout = Math.min(2_500, Math.floor(context.getRemainingTimeInMillis() - 700));
    if (timeout <= 0) throw new Error(DENIAL);
    const client = new CognitoIdentityProviderClient({ region: event.region, maxAttempts: 1,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 400, requestTimeout: timeout }) });

    try {

      // UsernameAttributes=email permits email here for every status; only definite absence permits creation.
      const existing = await client.send(new AdminGetUserCommand({ UserPoolId: event.userPoolId, Username: email }),
        { abortSignal: AbortSignal.timeout(timeout) });

      if (typeof existing.Enabled !== 'boolean' || !existing.UserStatus || !Object.values(UserStatusType).includes(existing.UserStatus)
        || typeof existing.Username !== 'string' || !existing.Username || !authSubSchema.safeParse(googleProfileAttribute(existing, 'sub')).success
        || googleEmail(googleProfileAttribute(existing, 'email')) !== email) throw new Error(DENIAL);

      // A previously linked destination is accepted only for the same trusted Google identity, never email alone.
      if (existing.Enabled && ['CONFIRMED', 'EXTERNAL_PROVIDER'].includes(existing.UserStatus)
        && googleProfileAttribute(existing, 'email_verified') === 'true' && googleProfileIdentity(existing) === provider[1]) return raw;

      throw new Error(DENIAL);
    }

    catch (error) {
      if (error instanceof UserNotFoundException) return raw;
      // eslint-disable-next-line preserve-caught-error -- Provider details must never reach Cognito's browser error redirect.
      throw new Error(DENIAL);
    }
  } catch { throw new Error(DENIAL); }
}
