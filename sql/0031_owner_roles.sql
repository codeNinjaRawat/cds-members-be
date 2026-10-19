-- 0031 The API connects as the database owner and switches to app_api / app_platform per transaction (SET LOCAL ROLE).
-- A superuser may always do that; a non-superuser owner (a managed database, a hosted server) needs the two roles
-- granted to itself. Re-runnable; does nothing for a superuser or when the roles are already granted.
DO $$ BEGIN
  -- already granted (e.g. by the server admin) → nothing to do; re-granting would need ADMIN OPTION and fail
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND NOT (pg_has_role(current_user, 'app_api', 'MEMBER') AND pg_has_role(current_user, 'app_platform', 'MEMBER')) THEN
    BEGIN
      EXECUTE format('GRANT app_api, app_platform TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'The database user % cannot use the roles app_api and app_platform. As a superuser run: GRANT app_api, app_platform TO %;', current_user, current_user;
    END;
  END IF;
END $$;
