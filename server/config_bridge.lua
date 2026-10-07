-- Bridges Customize fields the server.js needs at event time.
-- Modified fork: expose the studio bucket base to JavaScript.
-- JS reads via GetConvar('uz_autoshot_<key>', '<default>').
SetConvar('uz_autoshot_ace_restricted', Customize.AceRestricted and 'true' or 'false')
SetConvar('uz_autoshot_command',        Customize.Command or 'shotmaker')
SetConvar('uz_autoshot_bucket_base',    tostring(Customize.RoutingBucket or 999))
