import test from 'node:test';
import assert from 'node:assert/strict';
import {gameSeats,replacePlayerIds,presentGamePage} from '../server/game-presentation.mjs';

test('旧记录按座位和昵称展示投票、查验与身份，未知阶段不伪造，参赛视角不添加隐藏身份',()=>{
  const game={participants:['10001','10002H','10003'],joined:['10001','10002H','10003'],checkedIn:[],alive:['10001'],status:'finished',day:2,roles:{10001:'wolf','10002H':'witch',10003:'villager'},playerNames:{10001:'同名', '10002H':'同名',10003:'<script>例子</script>'}};
  const page={game:{gameId:'game'},messages:[
    {kind:'inspect_result',channel:'private',target:'10001',isWolf:true},
    {kind:'dawn',day:2,phase:'night_gods',channel:'public',deaths:['10002H']},
    {kind:'chat',channel:'public',sender:'10001',text:'10002H 说得有道理，100020和x10001不是玩家。'},
    {kind:'vote_result',channel:'public',eliminated:'10003',votes:{10001:'10003','10002H':'abstain'}},
    {kind:'finished',channel:'public',roles:game.roles,winner:'wolves'}
  ]};
  const visible=presentGamePage(game,page,id=>id);
  assert.ok(visible.game.seats.every(s=>!('role' in s)));assert.equal(visible.messages[0].display.round,'对局记录');
  assert.match(visible.messages[1].display.body,/2号 · 同名/);assert.match(visible.messages[2].display.speaker,/1号 · 同名/);
  assert.equal(visible.messages[1].display.round,'第 2 天 · 天亮结算','天亮事件可能在夜间状态结算时写入，展示应以事件为准');
  assert.equal(visible.messages[3].display.votes[1].target,'弃票');assert.equal(visible.messages[4].display.reveals.length,3);
  assert.match(visible.messages[2].display.body,/2号（同名）.*100020和x10001/);
  assert.equal(visible.messages[2].text,page.messages[2].text,'历史消息正文和动作参数不被展示层改写');
  const spectator=presentGamePage(game,page,id=>id,{omniscient:true});assert.equal(spectator.game.seats[1].role,'witch');
  assert.equal(presentGamePage(game,{game:{},messages:[]},id=>id).messages.length,0,'不会额外读取或添加私密消息');
});

test('游戏称呼只替换本局完整账号，保留普通数字及未知对象，匿名与同名可按座位区分',()=>{
  const game={joined:['10001','10002H'],status:'scheduled'},seats=gameSeats(game,id=>id);
  assert.equal(seats[0].nickname,'未设置昵称');assert.equal(seats[1].nickname,'匿名人类');
  assert.equal(replacePlayerIds('@10001，10002H，10001H，100011，x10001，10099',seats,'10099'),'@1号，2号，10001H，100011，x10001，法官');
});
