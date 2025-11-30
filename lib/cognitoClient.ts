// lib/cognitoClient.ts
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js';

function deriveUsernameFromEmail(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, '_')
    .slice(0, 30);
}

const poolData = {
  UserPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID as string,
  ClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID as string,
};

const userPool = new CognitoUserPool(poolData);

export function signInWithEmail(
  email: string,
  password: string
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    const user = new CognitoUser({
      Username: email,
      Pool: userPool,
    });

    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        resolve(session);
      },
      onFailure: (err) => {
        reject(err);
      },
      // If you ever use temp passwords / forced change:
      newPasswordRequired: () => {
        reject(
          new Error(
            'NEW_PASSWORD_REQUIRED: this user must change their temporary password in Cognito.'
          )
        );
      },
    });
  });
}

export function signUpWithEmail(
  email: string,
  password: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attributeList: CognitoUserAttribute[] = [];

    const emailAttribute = new CognitoUserAttribute({
      Name: 'email',
      Value: email,
    });

    attributeList.push(emailAttribute);

    // Cognito pool is configured with email as an alias, so the primary
    // username value cannot itself be in email format. Derive a
    // non-email username from the email for signup.
    const derivedUsername = deriveUsernameFromEmail(email);

    userPool.signUp(derivedUsername, password, attributeList, [], (err, result) => {
      if (err) {
        return reject(err);
      }
      // result contains CognitoUser and confirmation details, but
      // for the UI we just resolve to indicate success.
      resolve();
    });
  });
}

export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const username = deriveUsernameFromEmail(email);

    const user = new CognitoUser({
      Username: username,
      Pool: userPool,
    });

    user.confirmRegistration(code, true, (err, result) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}