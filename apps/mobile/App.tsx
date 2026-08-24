import React, {useEffect, useState} from 'react';
import {Button, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {mobileHost} from './src/bootstrap';

const screens = ['Home', 'Provider Settings', 'Import', 'Project', 'Proposal', 'Preview', 'Jobs', 'Settings'] as const;
type Screen = typeof screens[number];
const OPENAI_BASE = 'https://api.openai.com/v1';
const CREDENTIAL = 'provider.openai.shared';

function providerConfig(id: string, model: string) {
  return {schemaVersion: 1 as const, id, kind: 'openai' as const, displayName: `OpenAI · ${model}`, baseUrl: OPENAI_BASE, model, credentialRef: CREDENTIAL, authMode: 'DIRECT_BYOK' as const, reasoning: 'off' as const, modelDiscovery: 'api-with-static-fallback' as const, enabled: true, metadata: {client: 'native-mobile'}};
}

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('Home');
  const [status, setStatus] = useState('Starting native host…');
  const [projectId, setProjectId] = useState<string>(); const [assetId, setAssetId] = useState<string>(); const [strategyId, setStrategyId] = useState<string>();
  const [apiKey, setApiKey] = useState(''); const [plannerModel, setPlannerModel] = useState('gpt-5.4-mini'); const [asrModel, setAsrModel] = useState('gpt-4o-transcribe-diarize'); const [ttsModel, setTtsModel] = useState('gpt-4o-mini-tts');
  const [prompt, setPrompt] = useState('剪成 30 秒，去掉废话，开头保留最有信息量的一句。');

  useEffect(() => { void mobileHost.then(host => setStatus(`${host.profile.id} ready · provider restore errors: ${host.providerRestoreErrors.length}`)).catch(error => setStatus(String(error))); }, []);
  const run = async (label: string, action: () => Promise<unknown>) => { setStatus(`${label}…`); try { const value = await action(); setStatus(`${label} ✓\n${JSON.stringify(value, null, 2).slice(0, 1600)}`); } catch (error) { setStatus(`${label} failed: ${String(error)}`); } };

  const create = () => run('Create project', async () => { const result = await (await mobileHost).facade.createProject('Mobile proof'); setProjectId(result.project.id); return result.project; });
  const importVideo = () => run('Import video', async () => { if (!projectId) throw new Error('Create a project first'); const asset = await (await mobileHost).facade.importVideo(projectId); if (asset) setAssetId(asset.id); return asset; });
  const transcribe = () => run('Transcribe', async () => { if (!projectId || !assetId) throw new Error('Import a video first'); return (await mobileHost).facade.transcribe(projectId, assetId, {language: 'zh'}); });
  const connect = () => run('Configure AI stack', async () => {
    if (!apiKey.trim()) throw new Error('API key required');
    const host = await mobileHost;
    await host.facade.configurePlanner({...providerConfig('mobile-openai-planner', plannerModel), reasoning: 'medium'}, apiKey.trim());
    // ASR/TTS share the same secure credentialRef. The secret is written once above; these configs
    // store only the reference, not another plaintext copy.
    await host.facade.configureASR(providerConfig('mobile-openai-asr', asrModel));
    await host.facade.configureTTS(providerConfig('mobile-openai-tts', ttsModel));
    setApiKey('');
    return host.facade.providerHealth();
  });
  const propose = () => run('Propose edit', async () => { if (!projectId || !assetId) throw new Error('Import a video first'); const host = await mobileHost; const strategy = await host.facade.proposeEdit(projectId, assetId, prompt); setStrategyId(strategy.id); return {strategy, privacyEvidence: host.facade.privacyEvidence()}; });
  const approve = () => run('Approve and apply', async () => { if (!projectId || !strategyId) throw new Error('Create a proposal first'); return (await mobileHost).facade.approveProposal(projectId, strategyId); });
  const preview = () => run('Render preview', async () => { if (!projectId) throw new Error('No project'); return (await mobileHost).facade.renderPreview(projectId); });
  const voices = () => run('List TTS voices', async () => { if (!projectId) throw new Error('No project'); return (await mobileHost).facade.listVoices(projectId); });
  const jobs = () => run('List durable jobs', async () => projectId ? (await mobileHost).facade.listJobs(projectId) : []);
  const exportVideo = () => run('Export video', async () => { if (!projectId) throw new Error('No project'); return (await mobileHost).facade.exportVideo(projectId); });

  return <SafeAreaView style={styles.safe}>
    <View style={styles.header}><Text style={styles.title}>VIDEO AGENT</Text><Text style={styles.meta}>NATIVE HOST / ZERO MEDIA BACKEND</Text></View>
    <ScrollView horizontal style={styles.nav} contentContainerStyle={styles.navContent}>{screens.map(item => <TouchableOpacity key={item} onPress={() => setScreen(item)} style={[styles.tab, screen === item && styles.active]}><Text style={styles.tabText}>{item}</Text></TouchableOpacity>)}</ScrollView>
    <ScrollView contentContainerStyle={styles.body}><Text style={styles.kicker}>{screen.toUpperCase()}</Text>
      {screen === 'Home' && <><Text style={styles.heading}>Portable Core.{`\n`}Native media.</Text><Button title="Create local project" onPress={create}/></>}
      {screen === 'Provider Settings' && <>
        <TextInput secureTextEntry value={apiKey} onChangeText={setApiKey} placeholder="OpenAI API key · Keychain / Keystore" style={styles.input}/>
        <Text style={styles.label}>PLANNER</Text><TextInput value={plannerModel} onChangeText={setPlannerModel} placeholder="Planner model" style={styles.input}/>
        <Text style={styles.label}>ASR · TIMESTAMPED</Text><TextInput value={asrModel} onChangeText={setAsrModel} placeholder="gpt-4o-transcribe-diarize or whisper-1" style={styles.input}/>
        <Text style={styles.label}>TTS</Text><TextInput value={ttsModel} onChangeText={setTtsModel} placeholder="TTS model" style={styles.input}/>
        <Button title="Test + Save Planner / ASR / TTS" onPress={connect}/>
        <Text style={styles.note}>One secure credential, three independent model roles. Raw video is uploaded by NativeSpeechHost and never copied into React Native JS.</Text>
      </>}
      {screen === 'Import' && <><Button title="Choose video" onPress={importVideo}/><View style={styles.gap}/><Button title="Transcribe with configured ASR" onPress={transcribe}/></>}
      {screen === 'Project' && <Text style={styles.mono}>project {projectId ?? '—'}{`\n`}asset {assetId ?? '—'}</Text>}
      {screen === 'Proposal' && <><TextInput multiline value={prompt} onChangeText={setPrompt} style={[styles.input, styles.prompt]}/><Button title="Generate proposal" onPress={propose}/><View style={styles.gap}/><Button title="Approve + create Version" onPress={approve}/></>}
      {screen === 'Preview' && <><Button title="Render local preview" onPress={preview}/><View style={styles.gap}/><Button title="List configured TTS voices" onPress={voices}/><View style={styles.gap}/><Button title="Export local video" onPress={exportVideo}/></>}
      {screen === 'Jobs' && <Button title="Refresh durable jobs" onPress={jobs}/>} 
      {screen === 'Settings' && <Text style={styles.note}>Privacy defaults: text-only planning context. Raw video is excluded from LLM context; ASR media upload is a separate explicit speech operation pinned to the official endpoint.</Text>}
      <View style={styles.console}><Text style={styles.consoleLabel}>RUNTIME</Text><Text selectable style={styles.consoleText}>{status}</Text></View>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({safe:{flex:1,backgroundColor:'#0b0c0e'},header:{padding:20,paddingBottom:10,borderBottomWidth:1,borderColor:'#2a2d31'},title:{color:'#f3f1ea',fontSize:22,fontWeight:'800',letterSpacing:2},meta:{color:'#8c929b',fontSize:10,letterSpacing:1.5,marginTop:5},nav:{maxHeight:52},navContent:{paddingHorizontal:12,alignItems:'center'},tab:{paddingHorizontal:11,paddingVertical:9,marginRight:6,borderWidth:1,borderColor:'#282b30'},active:{backgroundColor:'#d8ff48',borderColor:'#d8ff48'},tabText:{fontSize:11,color:'#aeb3bb'},body:{padding:22,paddingBottom:80},kicker:{color:'#d8ff48',fontSize:11,letterSpacing:2,marginBottom:18},heading:{color:'#f3f1ea',fontSize:40,lineHeight:42,fontWeight:'700',marginBottom:28},label:{color:'#8c929b',fontSize:10,letterSpacing:1.5,marginBottom:7,marginTop:5},input:{backgroundColor:'#15171a',color:'#f3f1ea',borderWidth:1,borderColor:'#343840',padding:14,marginBottom:12},prompt:{minHeight:110,textAlignVertical:'top'},note:{color:'#aeb3bb',lineHeight:20,marginTop:18},mono:{color:'#d9dde3',fontFamily:'monospace',lineHeight:22},gap:{height:12},console:{marginTop:28,padding:14,backgroundColor:'#111316',borderLeftWidth:3,borderColor:'#d8ff48'},consoleLabel:{color:'#d8ff48',fontSize:10,letterSpacing:2,marginBottom:8},consoleText:{color:'#abb1ba',fontFamily:'monospace',fontSize:11,lineHeight:17}});
