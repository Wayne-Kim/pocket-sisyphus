package com.pocketsisyphus.android.data

import android.content.Context
import com.pocketsisyphus.android.billing.EntitlementStore
import com.pocketsisyphus.android.tor.TorManager

/** Process-wide singletons, initialized once from [com.pocketsisyphus.android.PsApp]. */
object Ps {
    lateinit var pairStore: PairStore
        private set
    lateinit var bridges: BridgeStore
        private set
    lateinit var tor: TorManager
        private set
    lateinit var connection: ConnectionManager
        private set
    lateinit var attest: Attestation
        private set
    lateinit var api: ApiClient
        private set
    lateinit var capabilities: CapabilityStore
        private set
    lateinit var entitlement: EntitlementStore
        private set
    lateinit var waitNotifier: AgentWaitNotifier
        private set
    lateinit var appLock: AppLock
        private set
    lateinit var appContext: Context
        private set

    fun init(context: Context) {
        if (::pairStore.isInitialized) return
        val app = context.applicationContext
        appContext = app
        pairStore = PairStore(app)
        appLock = AppLock(isPaired = { pairStore.isPaired })
        bridges = BridgeStore(app)
        tor = TorManager(app, bridges)
        connection = ConnectionManager(pairStore, tor)
        attest = Attestation(connection, app)
        api = ApiClient(connection, attest)
        capabilities = CapabilityStore(api)
        entitlement = EntitlementStore(context.applicationContext)
        waitNotifier = AgentWaitNotifier(app, connection, attest, api)
    }
}
