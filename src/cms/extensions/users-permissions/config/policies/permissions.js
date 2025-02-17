const _ = require("lodash");

const KEYCLOAK_AUTH_ROLES = ["submitter", "approver"];
const API_USER_EMAIL = process.env.STRAPI_API_USER_EMAIL;

module.exports = async (ctx, next) => {
  let role;

  if (ctx.state.user) {
    // request is already authenticated in a different way
    return next();
  }

  // add the detection of `token` query parameter
  if (
    (ctx.request && ctx.request.header && ctx.request.header.authorization) ||
    (ctx.request.query && ctx.request.query.token)
  ) {
    try {
      // init `id` and `isAdmin` outside of validation blocks
      let id;
      let isAdmin;
      let tokenType;
      let decodedToken;

      if (ctx.request.query && ctx.request.query.token) {
        // find the token entry that match the token from the request
        const [token] = await strapi
          .query("token")
          .find({ token: ctx.request.query.token });

        if (!token) {
          throw new Error(`Invalid token: This token doesn't exist`);
        } else {
          if (token.user && typeof token.token === "string") {
            id = token.user.id;
          }
          isAdmin = false;
        }

        delete ctx.request.query.token;
      } else if (
        ctx.request &&
        ctx.request.header &&
        ctx.request.header.authorization
      ) {
        // get information if token is keycloak type
        decodedToken = await strapi.plugins[
          "users-permissions"
        ].services.jwt.getKCToken(ctx);
        if (decodedToken) {
          tokenType = "keycloak";
        } else {
          // get information if token is strapi type
          decodedToken = await strapi.plugins[
            "users-permissions"
          ].services.jwt.getToken(ctx);
          if (decodedToken) {
            tokenType = "strapi";
          }
        }
      }

      if (decodedToken) {
        if (tokenType === "keycloak") {
          // fetch authenticated user using keycloak creds
          if (decodedToken.realm_access && decodedToken.realm_access.roles) {
            const roles = decodedToken.realm_access.roles;
            const roleMatch = roles.some((e) =>
              KEYCLOAK_AUTH_ROLES.includes(e)
            );

            if (!API_USER_EMAIL) {
              throw new Error("API_USER_EMAIL value not set");
            }

            if (roleMatch) {
              ctx.state.user = await strapi.plugins[
                "users-permissions"
              ].services.user.fetch({ email: API_USER_EMAIL });
            } else {
              throw new Error(
                "Invalid token: User role does not have access permissions"
              );
            }
          } else {
            throw new Error(
              "Invalid token: Token did not contain required fields"
            );
          }
        } else {
          id = decodedToken.id;
          isAdmin = decodedToken.isAdmin || false;
          if (id === undefined) {
            throw new Error(
              "Invalid token: Token did not contain required fields"
            );
          }
          // fetch authenticated user
          ctx.state.user = await strapi.plugins[
            "users-permissions"
          ].services.user.fetchAuthenticatedUser(id);
        }
      }
    } catch (err) {
      return handleErrors(ctx, err, "unauthorized");
    }

    if (!ctx.state.user) {
      return handleErrors(ctx, "User Not Found", "unauthorized");
    }

    role = ctx.state.user.role;

    if (role.type === "root") {
      return await next();
    }

    const store = await strapi.store({
      environment: "",
      type: "plugin",
      name: "users-permissions",
    });

    if (
      _.get(await store.get({ key: "advanced" }), "email_confirmation") &&
      !ctx.state.user.confirmed
    ) {
      return handleErrors(
        ctx,
        "Your account email is not confirmed.",
        "unauthorized"
      );
    }

    if (ctx.state.user.blocked) {
      return handleErrors(
        ctx,
        "Your account has been blocked by the administrator.",
        "unauthorized"
      );
    }
  }

  // Retrieve `public` role.
  if (!role) {
    role = await strapi
      .query("role", "users-permissions")
      .findOne({ type: "public" }, []);
  }

  const route = ctx.request.route;
  const permission = await strapi
    .query("permission", "users-permissions")
    .findOne(
      {
        role: role.id,
        type: route.plugin || "application",
        controller: route.controller,
        action: route.action,
        enabled: true,
      },
      []
    );

  if (!permission) {
    return handleErrors(ctx, undefined, "forbidden");
  }

  // Execute the policies.
  if (permission.policy) {
    return await strapi.plugins["users-permissions"].config.policies[
      permission.policy
    ](ctx, next);
  }

  // Execute the action.
  await next();
};

const handleErrors = (ctx, err = undefined, type) => {
  throw strapi.errors[type](err);
};
