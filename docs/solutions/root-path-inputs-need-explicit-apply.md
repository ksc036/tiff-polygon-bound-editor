# Root Path Inputs Need Explicit Apply

When an app lets users type or replace a project/image root path, do not rely on form submit by pressing Enter as the only apply action. If a finder button also exists, users can reasonably expect typed path changes to need a visible action. Provide an explicit submit button near the root path field and cover it with a regression test that changes an already loaded root.
